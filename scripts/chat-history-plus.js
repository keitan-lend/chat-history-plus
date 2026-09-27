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
const PENDING_TIMEOUT_MS = 4000; // janela de tempo pra associar clique -> mensagem de chat

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
    pendingMacroClick = null;

    if (macro.type === "script") {
      return {
        display: macro.command,
        execute: () => {
          try {
            macro.execute();
          } catch (err) {
            console.error(`${MODULE_ID} | falha ao reexecutar a macro "${macro.name}"`, err);
            ui.notifications?.error(`Não consegui refazer "${macro.name}" — veja o console (F12).`);
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
      pendingItemClick = null;
      return {
        display: `game.tormenta20.rollItemMacro("${name.replace(/"/g, '\\"')}")`,
        execute: () => {
          try {
            game.tormenta20.rollItemMacro(name);
          } catch (err) {
            console.error(`${MODULE_ID} | falha ao refazer o item "${name}"`, err);
            ui.notifications?.error(`Não consegui refazer "${name}" — veja o console (F12).`);
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
// IMPORTANTE: usamos "renderApplication" (que dispara pra QUALQUER
// Application, de qualquer classe) em vez de "renderActorSheet", porque
// módulos de ficha alternativa (ex: Ficha Heroica) registram sua própria
// classe de Application — "renderActorSheet" só dispara garantidamente se
// essa classe realmente estender ActorSheet na cadeia de herança, então
// "renderApplication" + checar app.actor é a forma mais à prova de módulo
// de pegar qualquer ficha, seja qual for a classe por trás dela.
Hooks.on("renderApplication", (app, html) => {
  if (!app?.actor) return; // só nos interessam fichas de ator (personagem, NPC, etc.)

  const root = html?.jquery ? html[0] : html;
  if (!root || root.dataset.chatHistoryPlusBound) return;
  root.dataset.chatHistoryPlusBound = "1";

  console.debug(`${MODULE_ID} | ouvindo cliques na ficha de "${app.actor.name}" (classe: ${app.constructor.name})`);

  root.addEventListener(
    "click",
    (event) => {
      const el = event.target.closest?.("[data-item-id]");
      if (!el) {
        console.debug(`${MODULE_ID} | clique na ficha ignorado (elemento sem data-item-id em nenhum ancestral)`, event.target);
        return;
      }
      const item = app.actor?.items?.get(el.dataset.itemId);
      if (!item) {
        console.debug(`${MODULE_ID} | data-item-id="${el.dataset.itemId}" encontrado, mas nenhum item correspondente no ator`);
        return;
      }
      console.debug(`${MODULE_ID} | clique capturado: item "${item.name}" do ator "${app.actor.name}"`);
      pendingItemClick = { actorId: app.actor.id, itemName: item.name, timestamp: Date.now() };
    },
    true // capture phase: garante que a gente vê o clique mesmo se a ficha parar a propagação
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
      current.execute();
      writeFieldText(el, "");
      pointer = history.length;
      pendingDraft = "";
      event.preventDefault();
      return false;
    }
    // texto normal (ou "/r ..."): deixa o Foundry processar como sempre
  }
});
