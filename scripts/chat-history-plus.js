/**
 * Chat History Plus
 * -----------------
 * Reproduz o comportamento do Roll20: QUALQUER coisa que gerou uma mensagem
 * no chat — digitada por você, uma macro, ou um poder/magia clicado na
 * ficha — fica disponível pra recuperar com a seta para cima, e ao apertar
 * Enter de novo ela é refeita por completo (não só a rolagem de dados).
 *
 * Estratégia:
 *  1) Escuta cliques em qualquer item de uma ficha aberta (data-item-id) e
 *     guarda momentaneamente "qual item foi clicado, de qual ator".
 *  2) Quando a ChatMessage correspondente é criada logo em seguida, associa
 *     as duas coisas e grava no histórico o comando real que refaz aquilo:
 *     game.tormenta20.rollItemMacro("Nome do Item")  — a MESMA função usada
 *     quando você arrasta o item pra hotbar.
 *  3) Se não for um item de ficha (ex: rolagem digitada manualmente ou uma
 *     rolagem solta), cai para "/r <fórmula>" ou pro texto puro da mensagem.
 *  4) Ao apertar Enter sobre um item recuperado do tipo "macro completa", a
 *     função é executada diretamente (não é só um texto que vira mensagem).
 *
 * Isso substitui completamente o histórico nativo do Foundry (que só grava
 * o que foi digitado manualmente no campo).
 */

const MODULE_ID = "chat-history-plus";
const MAX_HISTORY = 50;
// Janela de tempo pra associar "clique num poder/macro" -> "mensagem no chat".
// Precisa ser generosa porque muitos poderes do T20 abrem o AbilityUseDialog
// (escolher quanto PM gastar, confirmar) antes de rolar — e isso demora mais
// que alguns segundos na prática. O trade-off: se você digitar uma rolagem
// manual "/r ..." dentro dessa janela logo depois de clicar num poder, ela
// pode acabar marcada (incorretamente) como pertencente àquele poder.
const PENDING_TIMEOUT_MS = 60_000; // 60 segundos

/**
 * @typedef {Object} HistoryEntry
 * @property {string} display   texto mostrado/editável no campo de chat
 * @property {(() => void)|null} execute  se preenchido, é chamado ao dar Enter
 *   sem editar o texto (em vez de mandar o texto como mensagem comum)
 */

/** @type {HistoryEntry[]} do mais antigo pro mais novo */
let history = [];

/** posição atual; === history.length significa "fora do histórico" (digitando algo novo) */
let pointer = 0;

/** o que o usuário estava digitando antes de começar a navegar pelo histórico */
let pendingDraft = "";

/** último item clicado numa ficha, aguardando a ChatMessage confirmar */
let pendingItemClick = null; // { actorId, itemName, timestamp }

/** última macro executada (hotbar, diretório de macros, etc.), aguardando a ChatMessage confirmar */
let pendingMacroClick = null; // { macro, timestamp }

/** garante que só logamos o tipo do campo de chat uma vez, não a cada tecla */
let hasLoggedFieldType = false;

/**
 * Evento "falso" equivalente a um clique normal (sem shift/ctrl/alt).
 * Necessário porque, na v1.6.3 do Tormenta20, `game.tormenta20.rollItemMacro()`
 * não repassa `event` pra dentro de `item.roll({ event, ... })` — e `item.roll`
 * declara `event` como parâmetro próprio (não cai no `window.event` global).
 * Resultado: QUALQUER chamada a rollItemMacro para um item com rolagens ou
 * efeitos de uso quebra com "Cannot read properties of undefined (reading
 * 'shiftKey')" — inclusive num clique real na hotbar, sem nosso módulo no
 * meio. Contornamos chamando item.roll() nós mesmos, com esse evento falso.
 */
const FAKE_EVENT = { shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, type: "click" };

/** Acha um ator pelo id, cobrindo também atores de token não vinculados. */
function resolveActorById(actorId) {
  return (
    game.actors.get(actorId)
    ?? canvas?.tokens?.placeables?.find((t) => t.actor?.id === actorId)?.actor
    ?? null
  );
}

/**
 * Refaz a rolagem de um item pelo nome, chamando item.roll() diretamente
 * (contornando o bug do rollItemMacro descrito acima em FAKE_EVENT).
 */
function rollItemByName(actorId, itemName) {
  const actor = resolveActorById(actorId);
  if (!actor) {
    ui.notifications?.warn(`chat-history-plus: não encontrei o personagem pra refazer "${itemName}".`);
    return;
  }
  const item = actor.items.find((i) => i.name === itemName);
  if (!item) {
    ui.notifications?.warn(`O personagem "${actor.name}" não possui um item chamado "${itemName}".`);
    return;
  }
  return item.roll({ event: FAKE_EVENT });
}

/**
 * Roda `fn` só depois que o Enter foi solto (ou após 400 ms, o que vier antes).
 *
 * Por quê: o AbilityUseDialog do T20 tem `default: "use"`, e o Dialog do
 * Foundry aceita o botão padrão com Enter, escutando `keydown` no document.
 * Se reexecutarmos o poder DENTRO do keydown do Enter, o diálogo pode abrir
 * (o template já está em cache, então tudo resolve em microtasks) enquanto o
 * MESMO evento ainda sobe até o document — e ele se confirma sozinho com os
 * valores padrão, sem nunca aparecer. Adiando, o Enter já terminou.
 */
function runAfterEnterReleased(fn) {
  let done = false;
  let timer = null;
  const run = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    document.removeEventListener("keyup", onKeyUp, true);
    fn();
  };
  const onKeyUp = (e) => {
    if (e.key === "Enter") setTimeout(run, 0);
  };
  document.addEventListener("keyup", onKeyUp, true);
  timer = setTimeout(run, 400);
}

/** Extrai o nome do item de um comando gerado por rollItemMacro("Nome"). */
function extractItemNameFromMacroCommand(command) {
  const match = /rollItemMacro\(\s*["'](.+?)["']/.exec(command ?? "");
  return match?.[1] ?? null;
}

function stripHtml(html) {
  const div = document.createElement("div");
  div.innerHTML = html ?? "";
  return (div.textContent ?? "").trim();
}

/** true se `el` for um <textarea>/<input> de verdade (tem .value funcional) */
function isFormField(el) {
  return el?.tagName === "TEXTAREA" || el?.tagName === "INPUT";
}

/** Lê o texto atual do campo de chat, seja ele <textarea> ou contenteditable. */
function readFieldText(el) {
  return isFormField(el) ? el.value : (el.textContent ?? "");
}

/**
 * Escreve texto no campo de chat, seja ele <textarea> ou contenteditable, e
 * dispara um evento "input" pra qualquer listener interno do Foundry que
 * dependa dele para saber que o conteúdo mudou.
 */
function writeFieldText(el, text) {
  if (isFormField(el)) {
    el.value = text;
  } else {
    el.textContent = text;
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Move o cursor para o final do campo, seja ele <textarea> ou contenteditable. */
function moveCursorToEnd(el) {
  if (isFormField(el)) {
    if (typeof el.setSelectionRange === "function") {
      el.setSelectionRange(el.value.length, el.value.length);
    }
    return;
  }
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/** Constrói a entrada de histórico certa para uma ChatMessage recém-criada. */
function buildHistoryEntry(message) {
  // 1) Veio de uma macro executada há pouco (hotbar, diretório de macros)?
  //    É a fonte mais confiável: usamos o comando exato salvo na macro.
  if (pendingMacroClick && Date.now() - pendingMacroClick.timestamp < PENDING_TIMEOUT_MS) {
    const macro = pendingMacroClick.macro;
    // Não zeramos pendingMacroClick aqui de propósito: um único clique pode
    // gerar VÁRIAS mensagens em sequência (texto do custo + rolagem, por
    // exemplo, quando passa por um diálogo de confirmação). Deixamos essa
    // referência viva até expirar pelo tempo ou ser substituída por um clique
    // novo — mensagens repetidas viram a mesma entrada graças à deduplicação
    // de entradas consecutivas idênticas logo abaixo, em createChatMessage.

    if (macro.type === "script") {
      // Se o comando é do tipo rollItemMacro("Nome"), contornamos o bug do
      // sistema (ver FAKE_EVENT) chamando item.roll() nós mesmos, usando o
      // ator que falou na mensagem. Qualquer outra macro roda normalmente.
      const itemName = extractItemNameFromMacroCommand(macro.command);
      const actorId = message.speaker?.actor ?? null;
      return {
        display: macro.command,
        execute: () => {
          const onError = (err) => {
            console.error(`${MODULE_ID} | falha ao reexecutar a macro "${macro.name}"`, err);
            ui.notifications?.error(`Não consegui refazer "${macro.name}" — veja o console (F12).`);
          };
          try {
            if (itemName && actorId) {
              Promise.resolve(rollItemByName(actorId, itemName)).catch(onError);
            } else {
              macro.execute();
            }
          } catch (err) {
            onError(err);
          }
        },
      };
    }
    // macro do tipo "chat": é só texto/comando de chat, reenviar como texto já basta
    if (macro.command) return { display: macro.command, execute: null };
  }

  // 2) Veio de um clique recente num item da ficha (sem passar por macro)? -> macro completa
  if (pendingItemClick && Date.now() - pendingItemClick.timestamp < PENDING_TIMEOUT_MS) {
    const speakerActorId = message.speaker?.actor;
    if (!speakerActorId || speakerActorId === pendingItemClick.actorId) {
      const name = pendingItemClick.itemName;
      const actorId = pendingItemClick.actorId;
      // mesmo motivo do bloco de macro acima: não consumimos de imediato,
      // pra cobrir diálogos de confirmação que geram mais de uma mensagem.
      return {
        display: `game.tormenta20.rollItemMacro("${name.replace(/"/g, '\\"')}")`,
        execute: () => {
          const onError = (err) => {
            console.error(`${MODULE_ID} | falha ao refazer o item "${name}"`, err);
            ui.notifications?.error(`Não consegui refazer "${name}" — veja o console (F12).`);
          };
          try {
            // item.roll() direto, com evento falso (ver FAKE_EVENT), em vez de
            // game.tormenta20.rollItemMacro, que quebra na v1.6.3 do sistema.
            Promise.resolve(rollItemByName(actorId, name)).catch(onError);
          } catch (err) {
            onError(err);
          }
        },
      };
    }
  }

  // 2) Rolagem simples (digitada, ou de atributo/perícia sem vínculo com item)
  if (message.rolls?.length) {
    const formula = message.rolls[0]?.formula;
    if (formula) return { display: `/r ${formula}`, execute: null };
  }

  // 3) Texto puro
  const text = stripHtml(message.content);
  return text ? { display: text, execute: null } : null;
}

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | inicializado`);
  pendingItemClick = null;
  pendingMacroClick = null;
});

// Captura QUALQUER macro executada (clique na hotbar, duplo clique no
// diretório de macros, etc.) via libWrapper, sem precisar editar o core.
// Precisa rodar depois que libWrapper já registrou a si mesmo (hook "setup").
Hooks.once("setup", () => {
  if (!game.modules.get("lib-wrapper")?.active) {
    console.warn(
      `${MODULE_ID} | libWrapper não está ativo — cliques na hotbar não serão capturados (só cliques na ficha).`
    );
    return;
  }

  libWrapper.register(
    MODULE_ID,
    "Macro.prototype.execute",
    function (wrapped, ...args) {
      console.debug(`${MODULE_ID} | macro executada: "${this.name}" (tipo: ${this.type})`);
      pendingMacroClick = { macro: this, timestamp: Date.now() };
      return wrapped(...args);
    },
    "WRAPPER"
  );
});

// Captura cliques em itens (poderes, magias, perícias, armas) em qualquer
// ficha de ator aberta. `data-item-id` é a convenção padrão do Foundry para
// vincular um elemento clicável da ficha ao Item correspondente.
//
// IMPORTANTE: em vez de esperar um hook "render..." disparar (renderApplication
// e renderActorSheet não estavam disparando nos testes — motivo ainda não
// confirmado, possivelmente específico do Foundry v14 desse mundo), usamos um
// único listener fixado direto em `document`, ativo desde o carregamento do
// mundo. Pra descobrir a QUAL ator pertence o clique, procuramos entre as
// janelas abertas do Foundry (`ui.windows`) qual delas contém o elemento
// clicado e tem um `.actor` — isso não depende de hook nenhum disparar certo.
function findActorSheetApp(target) {
  for (const app of Object.values(ui.windows)) {
    if (!app?.actor) continue;
    const root = app.element?.jquery ? app.element[0] : app.element;
    if (root?.contains?.(target)) return app;
  }
  return null;
}

Hooks.once("ready", () => {
  console.log(`${MODULE_ID} | escutando cliques em itens de fichas de ator (via ui.windows, independente de hooks de render)`);

  document.addEventListener(
    "click",
    (event) => {
      const el = event.target.closest?.("[data-item-id]");
      if (!el) return; // clique fora de qualquer item — nada a fazer aqui

      const app = findActorSheetApp(event.target);
      if (!app) {
        console.debug(`${MODULE_ID} | clique em [data-item-id] fora de uma ficha de ator conhecida (ui.windows)`, el);
        return;
      }

      const item = app.actor?.items?.get(el.dataset.itemId);
      if (!item) {
        console.debug(
          `${MODULE_ID} | data-item-id="${el.dataset.itemId}" não encontrado nos itens de "${app.actor?.name}"`
        );
        return;
      }

      console.debug(`${MODULE_ID} | clique capturado: item "${item.name}" do ator "${app.actor.name}"`);
      pendingItemClick = { actorId: app.actor.id, itemName: item.name, timestamp: Date.now() };
    },
    true // capture phase: garante que a gente vê o clique mesmo se algo parar a propagação depois
  );
});

// Captura QUALQUER mensagem criada, mas só guarda no histórico as que você
// mesmo gerou (não enche seu histórico com rolagens de outros jogadores).
Hooks.on("createChatMessage", (message) => {
  const authorId = message.author?.id ?? message.user?.id;
  if (authorId !== game.user.id) return;

  const entry = buildHistoryEntry(message);
  if (!entry) return;
  console.debug(`${MODULE_ID} | adicionado ao histórico:`, entry.display, entry.execute ? "(executável)" : "(texto)");

  const last = history[history.length - 1];
  if (last && last.display === entry.display) {
    pointer = history.length;
    return;
  }

  history.push(entry);
  if (history.length > MAX_HISTORY) history.shift();
  pointer = history.length;
});

// Intercepta seta para cima/baixo (navegação) e Enter (execução) no campo de
// chat, substituindo o comportamento nativo do core.
Hooks.on("chatInput", (event, options) => {
  const el = event.target;

  if (!hasLoggedFieldType) {
    hasLoggedFieldType = true;
    console.debug(
      `${MODULE_ID} | campo de chat detectado: <${el.tagName?.toLowerCase()}>`,
      isFormField(el) ? "(textarea/input padrão)" : "(NÃO é textarea/input — tratado como contenteditable)"
    );
  }

  if (event.key === "ArrowUp" || event.key === "ArrowDown") {
    if (history.length === 0) return;

    if (event.key === "ArrowUp") {
      if (pointer === history.length) pendingDraft = readFieldText(el);
      if (pointer > 0) {
        pointer -= 1;
        writeFieldText(el, history[pointer].display);
      }
    } else {
      if (pointer < history.length - 1) {
        pointer += 1;
        writeFieldText(el, history[pointer].display);
      } else if (pointer === history.length - 1) {
        pointer = history.length;
        writeFieldText(el, pendingDraft);
      }
    }

    requestAnimationFrame(() => moveCursorToEnd(el));
    if (options) options.recordPending = false;
    event.preventDefault();
    return false;
  }

  if (event.key === "Enter" && !event.shiftKey) {
    const current = history[pointer];
    // só executa a macro se o texto não foi editado — senão deixa virar
    // uma mensagem/comando normal de chat.
    if (current?.execute && readFieldText(el) === current.display) {
      runAfterEnterReleased(current.execute);
      writeFieldText(el, "");
      pointer = history.length;
      pendingDraft = "";
      event.preventDefault();
      return false;
    }
    // texto normal (ou "/r ..."): deixa o Foundry processar como sempre
  }
});
