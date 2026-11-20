# Baby Pocket — editor Android para o M-VAVE CUBE Baby

App web instalável (PWA) que fala com a pedaleira por **USB-MIDI** usando Web MIDI no **Chrome para Android**.
Não oficial, sem garantia. Protocolo estudado a partir do projeto MIT
[cubecontrol-app](https://github.com/MrGariZack/cubecontrol-app); o código daqui foi escrito do zero.

## O que tem
- **Editor**: slots A/B/C, 10 knobs (Volume, IR Cab, Reverb, Mix, FB, Time, Mod, Tone, Gain, Type), liga/desliga das 3 seções, desfazer/refazer, comparar com o salvo, copiar entre slots, salvar slot (com backup e conferência).
- **Afinador**: cromático e violão/guitarra, A4 ajustável, escolha da entrada de áudio.
- **Biblioteca**: timbres com nome, categoria e favoritos (guardados no aparelho).
- **Pedal**: exportar/importar banco (JSON), backups automáticos, modo demonstração (sem pedal).

## O que NÃO tem (de propósito)
- **Gravar IR (WAV) na memória flash**: é a operação de maior risco. Fica para uma próxima versão, com cuidado.
- Igualar volumes A/B/C, músicas/shows, sincronização na nuvem.

## Como usar no celular
Web MIDI só funciona em **HTTPS** (ou localhost), então o app precisa ser hospedado uma vez.

1. **Hospedar** (grátis): crie um repositório no GitHub, suba estes arquivos na raiz e ative
   *Settings → Pages → Deploy from a branch → main / (root)*. O endereço será `https://SEU-USUARIO.github.io/NOME/`.
2. No **Chrome do Android**, abra o endereço e use **⋮ → Instalar app / Adicionar à tela inicial**.
3. Ligue o pedal ao celular com um **cabo USB-C/OTG** de dados.
4. Abra o app e toque em **Conectar pedal**. Permita o acesso MIDI quando o Chrome pedir.
5. Antes de mexer: **Pedal → Exportar banco**.

Sem pedal à mão? **Pedal → Testar em modo demonstração** simula um pedal.

## Segurança
| Nível | Operações |
|---|---|
| Baixo | knobs ao vivo, trocar slot, afinador (só RAM, reversível) |
| Médio | salvar slot, importar banco (sobrescreve presets; o app guarda backup antes) |

Feche o CubeSuite/CubeControl no PC antes de conectar: só um programa pode usar o MIDI do pedal.

## Testes
```
node tests/protocol.test.mjs   # mensagens contra capturas reais do pedal
node tests/pitch.test.mjs      # afinador com sinais sintéticos
```

## Estado dos testes
Protocolo validado byte a byte contra capturas reais do pedal; interface testada de ponta a ponta com o
pedal de demonstração; afinador testado com sinais sintéticos. **Ainda não foi testado com um pedal real
via Chrome/Android**: comece pelos knobs ao vivo antes de salvar qualquer coisa.


## Versão 2 (interface estilo "rig")
- Rodapé fixo com cenas A/B/C, TAP (BPM) e Salvar; navegação Rig · Presets · Palco · Afinador · Ajustes.
- TAP ajusta o *Time* do delay (40–240 BPM; notas 1/4, 1/8, 1/8. e 1/16; passo de ~32 ms, como no CubeControl).
- Palco: botões grandes e tela sempre acesa. Nomes dos slots ficam só no aparelho.
- Presets compartilháveis como arquivo (`.bpreset.json`), com validação ao importar.
- Continua sem gravar IR na flash (risco alto).

## Cenas (v10)
Cada banco (A/B/C) tem 3 cenas guardadas na memória do app. Uma cena guarda volume, reverb, mix, feedback, time, mod, tone, gain e liga/desliga das seções. **Não guarda Type (amplificador) nem Cab (IR).** Ao escolher uma cena, os valores vão ao pedal na RAM; "Salvar" continua sendo o único passo que grava na flash.
