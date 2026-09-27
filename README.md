# Chat History Plus

Módulo pessoal para o Foundry VTT (feito para o sistema **Tormenta20**) que reproduz o
comportamento do Roll20: **qualquer coisa que aparece no chat pode ser recuperada
apertando a seta para cima no campo de mensagem** — não só o que você digitou manualmente,
mas também rolagens completas de poderes, magias e perícias, venham elas de um clique na
ficha ou de um clique num slot da hotbar.

## O que ele faz

O histórico nativo do Foundry (seta para cima no chat) só lembra do que foi **digitado**
no campo de texto. Uma rolagem que sai da ficha ou de uma macro nunca passa por esse
campo — ela é criada direto via API (`ChatMessage.create()`), então o Foundry não tem
como saber que ela existiu para fins de recall.

Este módulo substitui esse histórico por um próprio, que capta a origem de cada mensagem
por três caminhos, nessa ordem de prioridade:

1. **Macro executada (hotbar ou diretório de macros)** — via `libWrapper`, intercepta
   `Macro.prototype.execute` e guarda o comando exato salvo na macro (por exemplo
   `game.tormenta20.rollItemMacro("Ladainha de Combate")`). Ao recuperar essa entrada e
   apertar **Enter sem editar o texto**, a macro é **reexecutada de verdade** — reproduz o
   efeito completo, igual ao clique original no slot da hotbar.
2. **Clique direto num item da ficha** (poder/magia/perícia clicado sem passar por uma
   macro) — captado via `data-item-id` no elemento clicado dentro da ficha do ator.
   Monta o mesmo tipo de comando do item 1.
3. **Rolagem digitada manualmente ou avulsa** — cai para `/r <fórmula>` (a fórmula de
   dados da rolagem) ou para o texto puro da mensagem, quando não há vínculo com item ou
   macro nenhuma.

Se você editar o texto recuperado antes de apertar Enter, o módulo não tenta mais
executar a macro — ele deixa o Foundry tratar como uma mensagem/comando normal.

## Dependência obrigatória: libWrapper

Este módulo **exige** o módulo [libWrapper](https://github.com/ruipin/fvtt-lib-wrapper)
para funcionar. Sem ele, a captura via macro (item 1 da lista acima) fica indisponível —
e como ele está declarado como dependência obrigatória no manifest
(`relationships.requires`), o próprio Foundry vai bloquear a ativação deste módulo se o
libWrapper não estiver instalado e ativo no mundo.

- **Manifest do libWrapper:**
  `https://github.com/ruipin/fvtt-lib-wrapper/releases/latest/download/module.json`
- Instale-o em **Configuração e Setup → Add-on Modules → Install Module**, colando essa
  URL no campo "Manifest URL", e ative-o em **Gerenciar Módulos** antes (ou junto) de
  ativar o Chat History Plus.

(Se você já tem o libWrapper instalado no seu mundo — como já parece ser o caso — não
precisa fazer nada além de garantir que ele está habilitado.)

## Instalação

### Opção A — pela Manifest URL (recomendado, permite atualização automática)

1. Garanta que o **libWrapper** está instalado e ativo (veja acima).
2. Na tela de Setup do Foundry, vá em **Add-on Modules → Install Module**.
3. Cole no campo "Manifest URL":
   `https://github.com/keitan-lend/chat-history-plus/releases/latest/download/module.json`
4. Clique em "Install".
5. Ative **Chat History Plus** em **Configurações do Mundo → Gerenciar Módulos**.

### Opção B — manual (extraindo o zip)

1. Extraia este zip em `Data/modules/chat-history-plus/` (a pasta precisa se chamar
   exatamente `chat-history-plus`, igual ao `id` do `module.json`).
2. Garanta que o **libWrapper** está instalado e ativo (veja acima).
3. Reinicie o Foundry ou clique em "Refresh Packages" na tela de setup.
4. Ative **Chat History Plus** em **Configurações do Mundo → Gerenciar Módulos**.

> A Opção A só funciona depois que a Release `v1.0.0` (com os arquivos `module.json` e
> `chat-history-plus.zip` anexados) for publicada no repositório. Antes disso, use a
> Opção B com o zip baixado diretamente.

## Limitações conhecidas / pontos a validar

- A captura por clique na ficha (item 2) depende do elemento ter o atributo
  `data-item-id` num ancestral — é assim que o sistema **Tormenta20 base** (v1.6.3)
  marca cada item na lista (confirmado direto no código-fonte,
  `templates/actor/parts/lists/*.hbs` + `module/sheets/actor-base.mjs`). **Se você usa
  um módulo de ficha alternativa** (ex: *Tormenta20: Ficha Heroica*), ele pode usar uma
  estrutura HTML própria, com outro nome de atributo — nesse caso a captura por clique
  na ficha não vai funcionar até ajustarmos o seletor para a marcação real dessa ficha.
- A interceptação do Enter assume que o hook `chatInput` do Foundry dispara também para
  essa tecla (a documentação oficial não deixa isso 100% explícito). Se o Enter só
  reenviar o texto como mensagem em vez de executar a macro, essa é a causa mais provável.
- Testado nominalmente contra Foundry v14.365 / Tormenta20 v1.6.3. Pode precisar de
  ajustes em outras versões.

## Como diagnosticar se algo não funcionar

O módulo grava mensagens de diagnóstico no console do navegador (tecla **F12** →
aba "Console"). Com o console aberto:

1. **Clique num poder/magia na ficha.** Deve aparecer uma destas linhas:
   - `chat-history-plus | clique capturado: item "Nome" do ator "..."` → capturou certo,
     o problema está em outra etapa.
   - `chat-history-plus | clique na ficha ignorado (elemento sem data-item-id em
     nenhum ancestral)` → a ficha que você usa (provavelmente um módulo de ficha
     alternativa) não usa `data-item-id`. Copie o HTML do elemento clicado (F12 →
     botão direito no nome do poder → Inspecionar) e ajuste o seletor no código.
   - Nenhuma linha aparece → o listener nem foi anexado a essa ficha (confira se
     apareceu a linha `ouvindo cliques na ficha de "..."` quando você abriu a ficha;
     se não apareceu, feche e reabra a ficha depois de ativar o módulo).
2. **Clique num slot da hotbar.** Deve aparecer:
   `chat-history-plus | macro executada: "Nome" (tipo: script)`. Se não aparecer,
   confira se o libWrapper está mesmo ativo (**Configurações do Mundo → Gerenciar
   Módulos**).
3. Depois de qualquer rolagem, deve aparecer:
   `chat-history-plus | adicionado ao histórico: <comando> (executável)` ou
   `(texto)`. Se a rolagem some sem essa linha aparecer, ela não está batendo com
   nenhum dos casos tratados em `buildHistoryEntry` — me manda o print do console
   nesse ponto que eu ajusto.

## Histórico de depuração

Na primeira rodada de testes, o clique na ficha **já estava sendo capturado
corretamente** (confirmado pelo log `adicionado ao histórico: ...`), mas nada
aparecia visualmente ao apertar a seta pra cima. A causa real era esta:

```
Uncaught TypeError: el.setSelectionRange is not a function
```

O campo de chat do Foundry, nessa versão, não é um `<textarea>` comum — então
`el.value = texto` não tinha efeito nenhum (o JS aceita a atribuição sem erro,
só que sem efeito visual em um elemento que não seja `<textarea>`/`<input>`).
O código agora detecta o tipo real do campo (`isFormField`) e escreve o texto
do jeito certo para cada caso (`.value` ou `.textContent`), além de logar uma
única vez qual `<tag>` é o campo de chat de verdade, pra facilitar futuras
depurações.

## Segunda rodada de depuração: janela de tempo curta demais

O clique no poder/macro estava sendo capturado certinho, mas a associação com a
mensagem de chat expirava antes de acontecer — muitos poderes do T20 abrem o
`AbilityUseDialog` (escolher PM, confirmar) antes de rolar, e isso facilmente
passa dos poucos segundos que a janela original dava. A janela agora é de
**60 segundos**, e o clique pendente não é mais "consumido" na primeira
mensagem — fica disponível até expirar ou até um novo clique substituí-lo, o
que cobre ações que geram várias mensagens em sequência (texto do custo +
rolagem, por exemplo).

**Trade-off consciente:** se você digitar uma rolagem manual (`/r ...`) na
janela de 60s logo depois de clicar num poder do mesmo personagem, ela pode
acabar marcada (errado) como pertencente àquele poder. Na prática isso deve
ser raro; se incomodar, dá pra reduzir `PENDING_TIMEOUT_MS` no topo do
arquivo.

## Terceira rodada de depuração: o hook de renderização nunca disparava

Depois da correção da janela de tempo, o clique na ficha continuava caindo no
modo "só a fórmula" (`/r 1d20 + 5 + 0`), mesmo pra um ataque de arma resolvido
na hora (sem diálogo demorado). O log confirmou: nenhuma das mensagens de
diagnóstico ligadas a `Hooks.on("renderApplication", ...)` — nem "ouvindo
cliques na ficha", nem "clique capturado"/"clique ignorado" — jamais apareceu,
mesmo com o clique visivelmente vindo do `_onItemRoll` da ficha (visível no
próprio stack trace do erro de depreciação do Foundry). Ou seja: o hook de
renderização simplesmente não estava disparando pra essa ficha, por um motivo
que não deu pra confirmar só lendo código-fonte.

A solução foi parar de depender de qualquer hook `render*` : agora um único
listener de clique é registrado direto no `document` assim que o mundo carrega
(`Hooks.once("ready", ...)`), e a ficha dona do clique é encontrada varrendo o
registro `ui.windows` do próprio Foundry (todas as janelas abertas) até achar
uma que contenha o elemento clicado e tenha um `.actor`. Isso não depende de
nenhum hook de renderização disparar — só do clique acontecer.

## Versão

1.0.0 — repositório: https://github.com/keitan-lend/chat-history-plus
