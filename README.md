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

1. Extraia este zip em `Data/modules/chat-history-plus/` (a pasta precisa se chamar
   exatamente `chat-history-plus`, igual ao `id` do `module.json`).
2. Garanta que o **libWrapper** está instalado e ativo (veja acima).
3. Reinicie o Foundry ou clique em "Refresh Packages" na tela de setup.
4. Ative **Chat History Plus** em **Configurações do Mundo → Gerenciar Módulos**.

## Limitações conhecidas / pontos a validar

- A captura por clique na ficha (item 2) depende do elemento ter o atributo
  `data-item-id` — convenção comum no Foundry, mas não garantida pela ficha do T20 em
  todas as versões. Se não funcionar, inspecione o elemento (F12 → botão direito →
  Inspecionar) e ajuste `scripts/chat-history-plus.js`.
- A interceptação do Enter assume que o hook `chatInput` do Foundry dispara também para
  essa tecla (a documentação oficial não deixa isso 100% explícito). Se o Enter só
  reenviar o texto como mensagem em vez de executar a macro, essa é a causa mais provável.
- Testado nominalmente contra Foundry v14.365 / Tormenta20 v1.6.2. Pode precisar de
  ajustes em outras versões.

## Versão

1.0.0 — repositório: https://github.com/keitan-lend/chat-history-plus
