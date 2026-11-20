# Spartan Live

Transmissão de tela no próprio servidor. Um programa Windows publica o monitor por RTMP. O site autentica quem assiste e entrega HLS de baixa latência. O servidor não recodifica e não grava. No PC, a caixa Guardar 10 min pode manter só o rolo recente.

O atraso esperado na rede local é de cerca de 5 segundos. O servidor retém 120 segmentos de 1 segundo.

## Componentes

| Serviço | Função |
| --- | --- |
| `spartan-live-motor` | [MediaMTX](https://github.com/bluenviron/mediamtx) 1.21.3. Recebe RTMP na porta 1935 e gera LL-HLS. |
| `spartan-live-site` | Login, proxy do HLS e a página. Escuta 8097 no host e 8080 no container. |
| `publisher` | Programa Windows. O arquivo único é `SpartanLive.exe`. |

O fluxo é: captura da tela, codificação H.264, MPEG-TS local, mux com AAC e envio FLV/RTMP. O site só libera a lista, o HLS e o download para quem tem sessão.

## Requisitos

- Debian ou Ubuntu, com Docker e o plugin `docker compose`.
- Windows 10 ou 11, 64 bits, para gerar e rodar o programa.
- Python 3.12 na máquina que gera o executável (NumPy 2.x, PySide6 6.12).
- Imagem do site: Node 26 Alpine. Player HLS: hls.js 1.7.x em `site/public/hls.min.js`.

## Servidor

```sh
sudo apt update
sudo apt install -y git docker.io docker-compose-v2
sudo usermod -aG docker "$USER"
```

Entra de novo na sessão para o grupo `docker` valer.

```sh
git clone https://github.com/wilbresley/spartan-live.git
cd spartan-live
chmod +x preparar.sh subir.sh instalar.sh
./instalar.sh
```

`instalar.sh` confere o Docker, executa `preparar.sh` e sobe os containers. `preparar.sh` cria, se ainda não existirem, `.env`, `motor/mediamtx.yml` e `publisher/publish.json`, com senhas novas: a do motor, a de leitura do site e o segredo que o motor manda para o site (`authMethod: http`). Esses três arquivos ficam fora do git.

Na instalação nova o admin da página é `spartan`, com senha sorteada na primeira subida e mostrada uma vez (`docker compose logs spartan-live-site | grep 'Senha inicial'`). O site exige a troca antes de assistir. As contas ficam em `users.json`, no volume `spartan-viewer`.

```sh
./subir.sh
```

O endereço local sai no final: `http://IP-DESTA-MAQUINA:8097`.

Atualizar a página sem apagar o login:

```sh
git pull
docker compose up -d --build spartan-live-site
```

Zerar o login apaga o volume e gera senhas novas:

```sh
docker compose down -v
./instalar.sh
```

## Programa Windows

Na pasta do projeto, no PowerShell:

```powershell
winget install --id Python.Python.3.12 -e
New-Item -ItemType Directory -Force publisher\ffmpeg | Out-Null
Invoke-WebRequest -Uri "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip" -OutFile "$env:TEMP\ffmpeg-gpl.zip"
Expand-Archive -Force "$env:TEMP\ffmpeg-gpl.zip" "$env:TEMP\ffmpeg-gpl"
Copy-Item "$env:TEMP\ffmpeg-gpl\ffmpeg-master-latest-win64-gpl\bin\ffmpeg.exe" publisher\ffmpeg\ffmpeg.exe
cd publisher
.\build.ps1
```

`build.ps1` instala o empacotador e o PySide6, gera `publisher\dist\SpartanLive.exe` e grava o ícone do projeto. O `publish.json` entra no executável só com host e porta: o apelido e a senha são da conta de quem transmite. O campo de servidor sai vazio.

`make_icon.py` regrava `assets\Spartan-Live.ico`. O build usa o ícone que já está no repositório.

Para o botão Download da página, no servidor:

```sh
mkdir -p download
cp /caminho/SpartanLive.exe download/SpartanLive.exe
```

O site entrega só esse arquivo, e só com sessão. No modo celular, antes de baixar, um aviso diz que o programa é só para Windows no PC e pergunta se a pessoa quer baixar mesmo assim. No modo PC o download começa direto.

### Uso

O programa pede apelido, senha da conta, servidor, tela ou janela/jogo, som do PC, microfone e a qualidade. Com a Página marcada, antes de abrir o vídeo ele confere a conta no site: se a senha não conferir, a live nem começa e aparece o aviso de que a conta ou a senha não conferem. O padrão é 1080p 60. A janela é Qt 6 (PySide6), sem a barra do Windows, e abre em 580×840 no centro do monitor principal. Arrastar a faixa de cima move a janela. As bordas e os cantos redimensionam pelo próprio Windows. O botão maximizar guarda o tamanho anterior.

O seletor **Tela** abre um painel visual com **miniaturas ao vivo** separadas em duas seções — **Telas** (`Tela 1 — ...`) e **Janelas e Programas** (`Janela: Título (jogo.exe)`) — com campo de busca no topo para filtrar pelo nome ou executável e botão **↻ Atualizar**. Na captura de janela/jogo, o programa usa *Windows Graphics Capture* e tenta `IsBorderRequired = False` para esconder a borda amarela. Se o sistema não esconder a borda, o WGC segue mesmo assim — em jogo DirectX o PrintWindow costuma travar, então a borda amarela é o menor mal. Só cai no `PrintWindow` (`PW_RENDERFULLCONTENT`, com ponteiro real) quando o WGC não abre de jeito nenhum, ou quando abre e fica cerca de 1 s sem quadro. Em PC com placa dedicada e iGPU, o WGC abre o Direct3D na dedicada (mais VRAM). A abertura de janela espera até 10 s pelo primeiro horário do ffmpeg; tela inteira continua em 4 s. Ao trocar de tela, de janela ou de qualidade, a sessão anterior é fechada (`IClosable.Close`) antes de soltar o Direct3D. Sem esse fechamento, cada troca deixava as threads e a memória da sessão antiga dentro do Spartan Live. A troca não espera essa limpeza: o ffmpeg anterior é encerrado e a captura nova começa em seguida. O processo de ffmpeg que já morreu é descartado à parte, sem fechar o cano da imagem nem o do som que estão no ar.

No **Som do PC**, a lista abre em **Dispositivos** e, abaixo, **Janelas e programas**, com busca. Além do alto-falante inteiro, há a opção **Som da janela / jogo selecionado**, que usa *WASAPI Application Loopback* (`ActivateAudioInterfaceAsync` com `VAD\Process_Loopback` por `PID`) para capturar apenas o áudio da janela ou jogo que está na imagem. Cada programa da lista é uma linha por processo, lembrada pelo executável, então um programa reaberto do mesmo exe continua sendo seguido. A imagem e o som não se trocam sozinhos: dá para deixar a tela inteira e ouvir só um programa, ou a janela de um jogo e o alto-falante.

Abaixo de 580×840 aparecem barras de rolagem independentes, vertical, horizontal ou as duas, afastadas da borda para o clique pegar a barra e não o redimensionamento. A roda do mouse rola na vertical. Shift e a roda rolam na horizontal. O volume do PC e o do microfone têm medidor. Trocar a qualidade com a live aberta reinicia só o encoder, no mesmo apelido. A página mostra "Trocando qualidade!" e segue na ponta.

Com a live aberta, a faixa de status mostra os dois contadores, mesmo quando um deles é zero. O olho é quem está logado na conta da página. A ampulheta é quem entrou pelo link temporário.

O apelido tem 2 a 24 caracteres: letras minúsculas, números, `_` e `-`, sem acento. Ele é o nome da live **e** o nome da conta no site: o motor só aceita publicar no caminho que é igual à conta, então ninguém entra na live de outra pessoa com a senha ou o apelido dela. O que foge disso é limpo no próprio campo: "José" vira `jos`, "Ana" vira `ana`.

O campo Servidor aceita IPv4 ou domínio, sem `http://`. O programa remove esquema, caminho e porta escritos ali. O RTMP usa a porta do `publish.json`, 1935. Um IP avisa o site em `http://IP:8097`. Um domínio tenta `https://dominio` e, se falhar, `http://dominio:8097`.

A caixa **Página** (ligada por padrão) fica no campo Servidor e manda a live para o site dos amigos. A caixa **Restreamer**, na linha de baixo, manda uma cópia se estiver marcada e com um endereço `rtmp://` ou `rtmps://` do [Restreamer](https://github.com/datarhei/restreamer) (Docker datarhei, não Restream.io), sem recodificar. As duas são independentes: as duas, só uma, ou nenhuma. A porta 1935 é do Spartan Live; o Restreamer precisa de outra (por exemplo 1936), senão os dois brigam no mesmo soquete. Esse destino extra não entra no `docker compose` daqui: sobe no Docker de quem usa, com a URL que o próprio Restreamer mostra.

Apelido, senha da conta, servidor, caixa Página, caixa Restreamer, endereço Restreamer, qualidade, monitor e aparelhos ficam em `%APPDATA%\SpartanLive\config.json`. A senha fica em texto puro ali, como antes ficava no `publish.json`. O log fica em `%APPDATA%\SpartanLive\spartan.log`, por 30 dias, sem senha. Em cada início ele anota a build do Windows, as placas DXGI com VRAM e qual seria escolhida para WGC, o modo real (`window` / `ddagrab` / `gdigrab`), o encoder, o alvo (tela ou `exe`/`hwnd`/`pid`), a GPU do WGC ou o motivo do PrintWindow, e nas falhas o tempo de espera, os frames vistos e o detalhe do ffmpeg. A pasta temporária do executável só descompacta o programa.

O som do PC começa no alto-falante padrão, ou no programa salvo se ele ainda estiver aberto. Dá para trocar o dispositivo, o programa ou o microfone com a live aberta. Os dois em "Sem som" deixam a faixa de áudio em silêncio até a pessoa escolher uma fonte, sem parar a live.

Trocar de monitor ou de janela/jogo durante a live reinicia só a captura de vídeo e redireciona o áudio só se o som estiver em "Som da janela / jogo selecionado". A página mostra "Trocando tela!" e segue na ponta. A imagem e o som são independentes: a lista de som abre em Dispositivos e, abaixo, Janelas e programas, com busca. Dá para transmitir a tela inteira e ouvir só um programa. Se o jogo ainda está aberto e a janela some na troca de tela cheia, a live mostra a arte de espera até a janela nova desse mesmo processo ficar estável. Se o programa fecha de verdade, essa janela sai da lista na hora, o campo pede outra tela, o Spartan Live vem para a frente e abre o seletor. A lista se atualiza sozinha enquanto o seletor está aberto. Abrir o programa de novo não volta sozinho para a live: é preciso clicar na janela nova, mesmo que o nome seja igual ao de antes. Minimizar a janela não pede outra tela nem mostra a arte, e a live não passa sozinha para o monitor inteiro. Enquanto a captura moderna da janela está aberta, um instante sem quadro novo repete o último quadro, sem pedir para a janela se redesenhar. Se a imagem fica preta e o programa não está como administrador, ele avisa e oferece abrir de novo elevado. A live sempre sai com faixa de áudio; sem dispositivo e sem microfone, essa faixa leva silêncio, e ligar o som depois não reinicia a transmissão.

Minimizar vai para a bandeja. Parado, o ícone é `assets/Spartan-Live.ico`. Transmitindo, `assets/Spartan-Live-ON.ico`. "Abrir com o Windows, sem iniciar a live" só registra o executável. A live não começa sozinha. Abaixo disso ficam duas caixas, sempre desmarcadas ao abrir o programa: compartilhar com convidados temporários e com convidados permanentes. Cada caixa manda o próprio flag (`guestsTemp` / `guestsPerm`) e libera só o tipo correspondente — a do temporário não mexe no permanente, e vice-versa. Conta com senha (acesso 1) vê todas as lives. Convidado temporário (acesso 2) e permanente (acesso 3) só veem quem marcou a caixa do tipo dele. Se o container do site reiniciar com a live ainda no ar, marque ou desmarque as caixas de novo: o compartilhar fica só na memória do Node. O apelido aceita até 24 caracteres (letras minúsculas, números, `_` e `-`) e fica na mesma linha do campo **Senha**, a senha da conta no site, com o aviso em letra miúda sob cada um. O botão Espectadores abre a lista de quem está nesta live, com apelido e selo, em A–Z, com filtro todos/olho/ampulheta/infinito e rolagem depois de 10 nomes. A caixa **Guardar 10 min** copia o mesmo mux já codificado para um buffer em `%APPDATA%\SpartanLive\replay`, sem recapturar a tela. Com Página ou Restreamer ligados, o botão continua **Transmitir** e o rolo é extra. Sem os dois, o botão vira **Guardar**: a captura é a mesma, mas não sai da máquina. **Salvar clipe** junta os pedaços já fechados e ignora o último, que ainda está sendo escrito — senão o começo do MP4 pode virar 2 ou 3 segundos da ponta atual.

### Codificação

O encoder usado é o primeiro que responder, nesta ordem: `h264_nvenc`, `h264_amf`, `h264_qsv`, `libx264`. GOP igual à taxa de quadros, sem quadros B, CBR, `bufsize` com o dobro da taxa. No processador, o preset é `veryfast`, e `ultrafast` em 720p 60 e 480p 30.

| Qualidade | Placa | Processador |
| --- | ---: | ---: |
| 1080p 60 | 14 Mbps | 12 Mbps |
| 1080p 30 | 8 Mbps | 8 Mbps |
| 720p 60 | 8 Mbps | 6 Mbps |
| 720p 30 | 5 Mbps | 4 Mbps |
| 480p 30 | 1,5 Mbps | 1,5 Mbps |

A tela entra pelo filtro `ddagrab`, o monitor inteiro, com o ponteiro real. Se o monitor for maior que a qualidade escolhida e couber em 4K (3840×2160), a placa reduz o quadro para 1080p ou 720p antes de copiá-lo. Monitor acima de 4K continua sendo reduzido na memória. Se o `ddagrab` não abrir, usa `gdigrab`. A janela entra encaixada nesse quadro. Quando o tamanho dela muda, inclusive ao ir para tela cheia, a live espera 3 segundos com a medida parada e encaixa a janela inteira de novo, sem trocar a resolução da transmissão. Em modo janela/jogo, os quadros BGRA entram por um *named pipe* (`\\.\pipe\spartan-vid-...`) com `-use_wallclock_as_timestamps 1` para o mesmo processo isolado de vídeo. O vídeo segue sozinho em MPEG-TS. O som do PC (ou o som isolado do processo da janela/jogo) e o microfone são lidos no Windows, reamostrados com soxr para 48 kHz estéreo, somados em ponto flutuante e entregues em blocos de 20 ms. O segundo processo copia o vídeo e grava AAC a 256 kbps. O deslocamento na junção é zero.

O player usa `liveSyncDuration` 1.5, `maxLiveSyncPlaybackRate` 1 e `maxAudioFramesDrift` 10.

## Rede

| Porta | Uso | Na internet |
| --- | --- | --- |
| 443 | Página atrás de um proxy HTTPS | Sim |
| 8097 | Página direta | Só na rede local |
| 1935 | RTMP do programa | Sim, se alguém transmitir de fora |
| 8888, 9997 | HLS e API do MediaMTX | Não. Só entre os containers |

Quem assiste de fora usa o domínio na 443. O proxy precisa disto. Sem `proxy_buffering off` o HLS atrasa, e sem `X-Forwarded-Proto` o cookie de sessão em HTTPS sai sem a marca Secure.

```nginx
proxy_pass http://192.168.1.10:8097;
proxy_http_version 1.1;
proxy_buffering off;
proxy_read_timeout 3600s;
proxy_set_header Host $host;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
```

Troque `192.168.1.10` pelo IP do host na rede local. Dentro de um container, `127.0.0.1` é o próprio container. No Nginx Proxy Manager, `proxy_buffering off` e `proxy_read_timeout 3600s` vão na configuração avançada do domínio.

O proxy laranja do Cloudflare encaminha HTTP e HTTPS. RTMP continua no DNS direto, sem esse proxy, com a TCP 1935 encaminhada no roteador.

## Página

Depois do apelido, o navegador pergunta se a pessoa quer ver no modo PC ou no modo celular. A escolha fica no `localStorage`. Em Ajustes, o botão mostra o outro modo: no PC aparece Modo Mobile; no celular, Modo PC.

Os dois modos usam o mesmo player. A casca muda.

No PC, a faixa de cima tem o menu ☰, o logo, o nome Spartan Live, quantos estão ao vivo e a engrenagem. Espectadores, Gerar link, teatro, tela cheia da grade e Sair ficam dentro da engrenagem. Ela abre um painel da direita até o meio da tela, com o mesmo desenho dos ajustes do celular. A troca de senha é um modal no centro, com senha atual, nova, repetição e o botão Trocar senha.

O ☰ abre a lista de lives da esquerda para dentro, por cima do grid, com 220 px de largura e a altura da janela. Uma camada escura cobre o resto. O X, o clique fora ou o ☰ de novo fecham. Ao lado do X, o alfinete fixa a lista: a camada some, o grid começa depois desses 220 px e a lista só sai se o alfinete for clicado de novo. Fixada, o teatro automático não entra. Sem live aberta, a faixa vertical "Cade a Live?" fica ao lado do grid, só na largura do texto. Com uma live aberta, essa faixa some.

No celular a tela é outra: vídeo na área, ☰ abre a lista pela esquerda e a engrenagem abre os ajustes em tela cheia. Não é o layout do PC deitado. Com uma live, ela ocupa a tela. Com duas ou mais, a faixa de baixo mostra Grid e o nome de cada uma, e rola para o lado se não couber. Grid mostra todas juntas: duas ficam uma sobre a outra; três ou mais seguem a grade de duas colunas. Tocar num nome volta aquela live para a tela cheia.

Em cada nome da lista, o apelido fica no centro. A linha do olho, da ampulheta e do infinito já ocupa o lugar dela o tempo todo, para o botão não mudar de tamanho. Sem ninguém assistindo, o nome fica no centro da caixa. Com alguém, o nome sobe para a linha dele e os ícones ficam na de baixo. Cada marca só aparece se o número for maior que zero.

Sem ninguém ao vivo, a área mostra um GIF triste, entre os 12 de `site/public/gifs/sad-1.gif` a `sad-12.gif`. Com gente ao vivo e a grade vazia, mostra um GIF feliz, entre os 12 de `happy-1.gif` a `happy-12.gif`. Cada GIF toca a animação 5 vezes e, na hora, entra o próximo da mesma lista. No fim, volta ao primeiro. As duas listas não se misturam. O navegador lembra em qual GIF cada lista parou.

O modo teatro, na engrenagem ou na tecla T, esconde o topo na hora. Com uma live tocando e o mouse parado por 30 segundos, o teatro entra sozinho. Com o menu de lives fixado, o automático não entra. A tecla T continua. No teatro manual, encostar no topo mostra a faixa. Esc sai do teatro. Quando entra uma live nova com a lista lateral oculta (modo teatro manual ou automático, tela cheia da grade ou tela cheia de um player), aparece um balão no canto superior esquerdo por 5 segundos, um por vez, sem encavalar. Enquanto ele está na tela, o mouse não abre a faixa de cima e não tira o teatro; as lives continuam. A lista de lives só abre no ☰. O mouse em cima do balão pausa a contagem, e ao sair ela continua de onde parou. Clicar no texto abre a live e dá play. O X fecha só o aviso e a interface volta ao normal. O volume de cada apelido fica no navegador. No quadro e na lista, o olho conta quem entrou com a senha, a ampulheta quem entrou pelo link temporário e o infinito quem entrou pelo link permanente. Em Ajustes dá para ocultar ou ativar os nomes no topo de cada quadro da grade. Picture-in-picture fica no controle do player.

Um apelido na lista coloca o quadro parado. O vídeo só baixa no play. Clicar de novo no apelido, ou no X do quadro, remove o player. O X não encerra a transmissão.

No PC, uma live ocupa a área. Duas lives ficam lado a lado enquanto a janela do navegador tem pelo menos metade da largura do monitor. Abaixo disso, ficam uma sobre a outra, para a imagem 16:9 usar a largura e sobrar menos tarja. Três ou mais continuam em duas colunas. No celular, duas lives no Grid ficam uma sobre a outra; três ou mais usam as duas colunas. Cada quadro mostra o apelido no topo, centralizado, o tempo todo, para distinguir lives do mesmo jogo. Clicar no quadro amplia. Clicar de novo, ou Esc, volta à grade. A grade e cada quadro têm tela cheia.

A reprodução começa muda. O volume vai de 0% a 200%, de 5 em 5 (acima de 100% amplifica via `GainNode` da Web Audio API). Mutar guarda o último nível. No navegador, o volume salvo por apelido fica limitado a no máximo 100%, e ao iniciar o play o volume nunca passa de 100% para proteger quem usa fone de ouvido.

**Ao vivo** pula para a ponta. Fica verde com atraso de até 7 segundos e vermelho acima disso. Quem está tocando e passa de 90 segundos atrás volta para a ponta. Uma pausa de 5 minutos ou mais também recomece na ponta.

Parar no programa, ou fechar a janela, avisa o servidor e o apelido sai na hora. Se a pessoa reabre a transmissão em até 1 minuto, quem já estava assistindo recebe o quadro de volta na grade com reprodução automática. Uma queda espera 90 segundos, com o quadro em "Offline. Aguardando a reconexão." Se a pessoa volta, o player reabre na ponta.

Os sons de entrada e de saída tocam depois do login. A entrada marca uma live que começou. A saída marca uma parada, ou uma queda que passou de 90 segundos. Cada um espera 3 minutos antes de repetir o mesmo apelido. O botão em Ajustes liga e desliga os dois. Ajustes também troca a senha da própria conta e baixa o programa `SpartanLive.exe`. No celular, o download só começa depois do Sim no aviso de que o arquivo é para Windows.

Antes da grade, quem tem conta não escolhe apelido: o login já é o nome, e esse nome aparece no topo, à esquerda da engrenagem (a conta admin aparece como `Admin`). O convidado que abre um link escolhe um apelido de 2 a 24 caracteres, que fica no `localStorage` daquele navegador e vira o crachá `Convidado - Temp - apelido` ou `Convidado - Perm - apelido`. Sem apelido o convidado não entra na grade nem conta como espectador.

Quem entra pelo link temporário vê o tempo restante no topo; quem entra pelo permanente vê a marca Permanente no mesmo lugar. Em Ajustes, quem está logado vê Espectadores e Gerar link. Espectadores abre as lives e, ao clicar numa, os nomes com o selo do caminho (👁 / ⏳ / ∞). O convidado não vê esse botão. Um toque em Gerar link abre ou fecha as opções de 3, 6, 12 ou 24 horas. Segurar o mesmo botão por 10 segundos cria o link permanente, como no PC. Com um temporário já no ar, o toque avisa “já tem temporário”; segurar com permanente já no ar avisa “já tem permanente”. Dá para ter um temporário e um permanente ao mesmo tempo. Copiar e Revogar só aparecem depois que o link existe. Copiar é verde com texto branco; Revogar é vermelho com texto branco. A marca Permanente e o relógio do temporário seguem o mesmo desenho do botão Espectadores. Revogar pede confirmação. O endereço copiado usa o site aberto na barra. Cada geração usa um código novo. Os dois links têm códigos diferentes; o servidor classifica o visitante pelo código no `guest.json`, não pelo que o cookie antigo dizia.

Quem entra por esse endereço assiste a grade, o volume e o teatro, e só vê as lives cujo dono marcou o tipo de convite no programa. Não vê o gerador, a lista de espectadores, o download do programa nem a troca de senha. Link vencido, revogado ou desconhecido abre uma tela cinza com os GIFs tristes. Quem já estava assistindo continua nessa tela, sem voltar ao login: o texto diz se o convite foi revogado ou se o tempo acabou. O cookie de sessão é um só por navegador (e as janelas anônimas do mesmo navegador compartilham esse cookie). Abrir o link temporário e o permanente na mesma sessão anônima faz o segundo atropelar o primeiro — para testar os dois ao mesmo tempo, use dois navegadores diferentes (por exemplo Chrome e Edge).

## Contas

Cada pessoa tem a própria conta em `users.json`, no volume `spartan-viewer`, com papel de admin ou de usuário. Na instalação nova, o admin é o `VIEWER_USER` (por padrão `spartan`), com senha sorteada e troca obrigatória no primeiro login. Qualquer conta com senha assiste a grade; **Pessoas → Contas de acesso** só abre para o admin.

O admin cria a conta com o mesmo nome que a pessoa vai usar no programa: minúsculo, 2 a 24 caracteres, letras, números, `_` e `-`. A conta nasce **sem senha** e não entra no site nem publica até usar o link. O botão do link copia um endereço `/p/...`, que vale 7 dias e serve uma vez só: a página pede a senha nova (mínimo 8, diferente do nome da conta e fora da lista de senhas óbvias) e já entra logada.

Na mesma lista o admin redefine a senha — o link novo derruba as sessões abertas daquela conta, e o programa dela só volta a publicar digitando a senha nova —, troca o papel entre admin e usuário e exclui a conta. O último admin não sai, e ninguém exclui a própria conta. Sem `users.json` válido, o servidor guarda o arquivo quebrado de lado e cria a lista de novo.

Quem transmite digita no programa o apelido (a conta) e a senha da conta. O site só libera a publicação no caminho igual ao nome da conta, então ninguém publica no lugar de outra pessoa. Conta ainda sem senha não publica.

Na atualização de um servidor antigo, o `password.json` vira a senha da primeira conta. A credencial única dos programas antigos foi revogada: só publica quem digitar a conta e a senha dela. Ordem do deploy: site, motor e depois o `.exe` novo com a conta de cada um.

## Segurança

A senha de cada conta é scrypt, com sal próprio, em `users.json`. O cookie de sessão é HttpOnly e carrega o carimbo da senha: trocar ou redefinir a senha derruba as sessões antigas daquela conta. Em HTTPS ele também é Secure. Oito senhas erradas no mesmo IP bloqueiam esse IP por 5 minutos.

`X-Forwarded-For` só é aceito quando o pedido chega de um proxy local. Acesso direto na 8097 não escolhe o próprio IP.

O HLS e a lista exigem sessão de uma conta com senha. Publicar, parar, trocar de tela, enviar a miniatura e o compartilhamento com convidados exigem a conta de quem transmite, e o caminho publicado tem que ser o nome dessa conta. A credencial única antiga (`PUBLISH_USER` / `PUBLISH_PASSWORD`) não existe mais: o `.exe` velho não publica. O nome da live só aceita o mesmo conjunto do apelido. O visitante do link usa o mesmo cookie, com o prazo do convite ou longo no permanente, e não troca a senha nem baixa o programa. Os convites ficam em `guest.json`, no volume `spartan-viewer`, com temporário e permanente separados. Em cada pedido o servidor confere o código do cookie contra esse arquivo (acesso 2 ou 3) e aplica a caixa correspondente do programa. A limpeza das miniaturas usa todas as lives ativas, não só as que o convidado pode ver, para um visitante sem permissão não apagar a foto dos outros.

Ficam fora do git: `.env`, `motor/mediamtx.yml`, `publisher/publish.json`, `publisher/dist/`, `publisher/ffmpeg/`, `publisher/build/` e `download/`.

## Testes

```sh
cd publisher
python -m unittest test_spartan_live.py
```

```sh
cd site
node --test
```

Os testes do site sobem um servidor de verdade numa porta livre, com `users.json` e `guest.json` numa pasta temporária, e não tocam no volume do Docker.
