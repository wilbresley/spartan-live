# Spartan Live

Transmissão de tela no próprio servidor. Um programa Windows publica o monitor por RTMP. O site autentica quem assiste e entrega HLS de baixa latência. O vídeo não é transcodificado de novo e não fica gravado.

O atraso esperado na rede local é de cerca de 5 segundos. O servidor retém 120 segmentos de 1 segundo.

## Componentes

| Serviço | Função |
| --- | --- |
| `spartan-live-motor` | [MediaMTX](https://github.com/bluenviron/mediamtx) 1.21.2. Recebe RTMP na porta 1935 e gera LL-HLS. |
| `spartan-live-site` | Login, proxy do HLS e a página. Escuta 8097 no host e 8080 no container. |
| `publisher` | Programa Windows. O arquivo único é `SpartanLive.exe`. |

O fluxo é: captura da tela, codificação H.264, MPEG-TS local, mux com AAC e envio FLV/RTMP. O site só libera a lista, o HLS e o download para quem tem sessão.

## Requisitos

- Debian ou Ubuntu, com Docker e o plugin `docker compose`.
- Windows 10 ou 11, 64 bits, para gerar e rodar o programa.
- Python 3.12 na máquina que gera o executável.

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

`instalar.sh` confere o Docker, executa `preparar.sh` e sobe os containers. `preparar.sh` cria, se ainda não existirem, `.env`, `motor/mediamtx.yml` e `publisher/publish.json`, com senhas novas. A senha de transmitir é impressa uma vez. Esses três arquivos ficam fora do git.

Na instalação nova o login da página é `spartan` / `spartanadmin`. O site exige a troca antes de assistir. A senha nova fica no volume `spartan-viewer`.

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

`build.ps1` instala o empacotador e o PySide6, gera `publisher\dist\SpartanLive.exe` e grava o ícone do projeto. O `publish.json` entra no executável com o usuário e a senha de transmitir. O campo de servidor sai vazio.

`make_icon.py` regrava `assets\Spartan-Live.ico`. O build usa o ícone que já está no repositório.

Para o botão Download da página, no servidor:

```sh
mkdir -p download
cp /caminho/SpartanLive.exe download/SpartanLive.exe
```

O site entrega só esse arquivo, e só com sessão.

### Uso

O programa pede apelido, servidor, tela ou janela/jogo, som do PC, microfone e a qualidade. O padrão é 1080p 60. A janela é Qt 6 (PySide6), sem a barra do Windows, e abre em 560×720 no centro do monitor principal. Arrastar a faixa de cima move a janela. As bordas e os cantos redimensionam pelo próprio Windows. O botão maximizar guarda o tamanho anterior.

O seletor **Tela** abre um painel visual com **miniaturas ao vivo** separadas em duas seções — **Telas** (`Tela 1 — ...`) e **Janelas e Programas** (`Janela: Título (jogo.exe)`) — com campo de busca no topo para filtrar pelo nome ou executável e botão **↻ Atualizar**. Na captura de janela/jogo, o programa usa *Windows Graphics Capture* com `IsBorderRequired = False` quando o sistema suporta, ou `PrintWindow` (`PW_RENDERFULLCONTENT`) com desenho do ponteiro real, garantindo captura **sem borda amarela** no Windows 10 e no Windows 11 e sem expor outras telas no `Alt+Tab`. Ao trocar de tela, de janela ou de qualidade, a sessão anterior é fechada (`IClosable.Close`) antes de soltar o Direct3D. Sem esse fechamento, cada troca deixava as threads e a memória da sessão antiga dentro do Spartan Live. A troca não espera essa limpeza: o ffmpeg anterior é encerrado e a captura nova começa em seguida. O processo de ffmpeg que já morreu é descartado à parte, sem fechar o cano da imagem nem o do som que estão no ar.

No **Som do PC**, a lista abre em **Dispositivos** e, abaixo, **Janelas e programas**, com busca. Além do alto-falante inteiro, há a opção **Som da janela / jogo selecionado**, que usa *WASAPI Application Loopback* (`ActivateAudioInterfaceAsync` com `VAD\Process_Loopback` por `PID`) para capturar apenas o áudio da janela ou jogo que está na imagem. Cada programa da lista é uma linha por processo, lembrada pelo executável, então um programa reaberto do mesmo exe continua sendo seguido. A imagem e o som não se trocam sozinhos: dá para deixar a tela inteira e ouvir só um programa, ou a janela de um jogo e o alto-falante.

Abaixo de 560×720 aparecem barras de rolagem independentes, vertical, horizontal ou as duas, afastadas da borda para o clique pegar a barra e não o redimensionamento. A roda do mouse rola na vertical. Shift e a roda rolam na horizontal. O volume do PC e o do microfone têm medidor. Trocar a qualidade com a live aberta reinicia só o encoder, no mesmo apelido. A página mostra "Trocando qualidade!" e segue na ponta.

Com a live aberta, a faixa de status mostra os dois contadores, mesmo quando um deles é zero. O olho é quem está logado na conta da página. A ampulheta é quem entrou pelo link temporário.

O apelido tem 2 a 24 caracteres: letras, números, `_` e `-`. Ele é o nome da live.

O campo Servidor aceita IPv4 ou domínio, sem `http://`. O programa remove esquema, caminho e porta escritos ali. O RTMP usa a porta do `publish.json`, 1935. Um IP avisa o site em `http://IP:8097`. Um domínio tenta `https://dominio` e, se falhar, `http://dominio:8097`.

Apelido, servidor, qualidade, monitor e aparelhos ficam em `%APPDATA%\SpartanLive\config.json`. O log fica em `%APPDATA%\SpartanLive\spartan.log`, por 30 dias, sem senha. A pasta temporária do executável só descompacta o programa.

O som do PC começa no alto-falante padrão, ou no programa salvo se ele ainda estiver aberto. Dá para trocar o dispositivo, o programa ou o microfone com a live aberta. Os dois em "Sem som" deixam a faixa de áudio em silêncio até a pessoa escolher uma fonte, sem parar a live.

Trocar de monitor ou de janela/jogo durante a live reinicia só a captura de vídeo e redireciona o áudio só se o som estiver em "Som da janela / jogo selecionado". A página mostra "Trocando tela!" e segue na ponta. A imagem e o som são independentes: a lista de som abre em Dispositivos e, abaixo, Janelas e programas, com busca. Dá para transmitir a tela inteira e ouvir só um programa. Se o jogo ainda está aberto e a janela some na troca de tela cheia, a live mostra a arte de espera até a janela nova desse mesmo processo ficar estável. Se o programa fecha de verdade, essa janela sai da lista na hora, o campo pede outra tela, o Spartan Live vem para a frente e abre o seletor. A lista se atualiza sozinha enquanto o seletor está aberto. Abrir o programa de novo não volta sozinho para a live: é preciso clicar na janela nova, mesmo que o nome seja igual ao de antes. Minimizar a janela não pede outra tela nem mostra a arte, e a live não passa sozinha para o monitor inteiro. Enquanto a captura moderna da janela está aberta, um instante sem quadro novo repete o último quadro, sem pedir para a janela se redesenhar. Se a imagem fica preta e o programa não está como administrador, ele avisa e oferece abrir de novo elevado. A live sempre sai com faixa de áudio; sem dispositivo e sem microfone, essa faixa leva silêncio, e ligar o som depois não reinicia a transmissão.

Minimizar vai para a bandeja. Parado, o ícone é `assets/Spartan-Live.ico`. Transmitindo, `assets/Spartan-Live-ON.ico`. "Abrir com o Windows, sem iniciar a live" só registra o executável. A live não começa sozinha.

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

A lista começa fechada. A escolha fica no navegador. Com a lista fechada, uma live nova abre a coluna por 10 segundos. Clique, tecla ou rolagem seguram a coluna aberta. A sala vazia fecha a coluna.

Sem ninguém ao vivo, a área mostra um GIF triste, um de cada vez, entre os 12 de `site/public/gifs/sad-1.gif` a `sad-12.gif`. Quando entra uma live e a grade ainda está vazia, passa para um GIF feliz, entre os 12 de `happy-1.gif` a `happy-12.gif`. O navegador lembra o ponto da roleta.

O botão de modo teatro, ou a tecla T, esconde o topo na hora. Com uma live tocando e o mouse parado por 30 segundos, o teatro entra sozinho. No teatro manual, encostar no topo mostra a faixa. Esc sai do teatro. Quando entra uma live nova com a lista lateral oculta (modo teatro manual ou automático, tela cheia da grade ou tela cheia de um player), aparece um balão de notificação no canto superior esquerdo por 3 segundos (em fila, um por vez sem encavalar), e clicar no balão já abre e inicia a live da pessoa. O volume de cada apelido fica no navegador. No quadro e na lista, o olho conta quem entrou com a senha e a ampulheta conta quem entrou pelo link temporário. Os dois ficam lado a lado, olho primeiro, e cada um só aparece se o número for maior que zero. Sem ninguém assistindo, o contador some. Picture-in-picture fica no controle do player.

Um apelido na lista coloca o quadro parado. O vídeo só baixa no play. Clicar de novo no apelido, ou no X do quadro, remove o player. O X não encerra a transmissão.

Uma live ocupa a área. Duas lives ficam lado a lado enquanto a janela do navegador tem pelo menos metade da largura do monitor. Abaixo disso, ficam uma sobre a outra, para a imagem 16:9 usar a largura e sobrar menos tarja. Três ou mais continuam em duas colunas. Cada quadro mostra o apelido no topo, centralizado, o tempo todo, para distinguir lives do mesmo jogo. Clicar no quadro amplia. Clicar de novo, ou Esc, volta à grade. A grade e cada quadro têm tela cheia.

A reprodução começa muda. O volume vai de 0% a 200%, de 5 em 5 (acima de 100% amplifica via `GainNode` da Web Audio API). Mutar guarda o último nível. No navegador, o volume salvo por apelido fica limitado a no máximo 100%, e ao iniciar o play o volume nunca passa de 100% para proteger quem usa fone de ouvido.

**Ao vivo** pula para a ponta. Fica verde com atraso de até 7 segundos e vermelho acima disso. Quem está tocando e passa de 90 segundos atrás volta para a ponta. Uma pausa de 5 minutos ou mais também recomece na ponta.

Parar no programa, ou fechar a janela, avisa o servidor e o apelido sai na hora. Se a pessoa reabre a transmissão em até 1 minuto, quem já estava assistindo recebe o quadro de volta na grade com reprodução automática. Uma queda espera 90 segundos, com o quadro em "Offline. Aguardando a reconexão." Se a pessoa volta, o player reabre na ponta.

Os sons de entrada e de saída tocam depois do login. A entrada marca uma live que começou. A saída marca uma parada, ou uma queda que passou de 90 segundos. Cada um espera 3 minutos antes de repetir o mesmo apelido. O botão em Ajustes liga e desliga os dois. Ajustes também troca a senha da página e baixa o programa.

À esquerda do teatro, quem está logado gera um link de visita. O prazo é 3, 6, 12 ou 24 horas, contado da criação. Só existe um link por vez. Enquanto ele vale, o relógio vermelho mostra o que falta, o botão verde copia o endereço e Revogar encerra na hora. O endereço copiado usa o site aberto na barra: na rede local sai o IP, no domínio sai o domínio, e o caminho `/v/` é o mesmo. Gerar outro exige revogar o atual, ou esperar ele vencer. Cada geração usa um código novo. Várias pessoas podem abrir o mesmo endereço até ele vencer ou ser revogado.

Quem entra por esse endereço assiste a grade, o volume e o teatro. Não vê o gerador, o download do programa nem a troca de senha. À esquerda do teatro, vê só o tempo que falta no convite. Link vencido, revogado ou desconhecido abre uma tela cinza com os GIFs tristes. Quem já estava assistindo cai nessa tela quando o link acaba.

## Segurança

A senha da página é scrypt. O cookie de sessão é HttpOnly. Em HTTPS ele também é Secure. Oito senhas erradas no mesmo IP bloqueiam esse IP por 5 minutos.

`X-Forwarded-For` só é aceito quando o pedido chega de um proxy local. Acesso direto na 8097 não escolhe o próprio IP.

O HLS e a lista exigem sessão. Publicar, parar, trocar de tela e enviar a miniatura exigem o usuário e a senha do `publish.json`, distintos do login da página. O nome da live só aceita o mesmo conjunto do apelido. O visitante do link temporário usa o mesmo cookie, com o prazo do convite, e não troca a senha nem baixa o programa. O convite fica em `guest.json`, no volume `spartan-viewer`, um de cada vez.

Ficam fora do git: `.env`, `motor/mediamtx.yml`, `publisher/publish.json`, `publisher/dist/`, `publisher/ffmpeg/`, `publisher/build/` e `download/`.

## Testes

```sh
cd publisher
python -m unittest test_spartan_live.py
```

```sh
cd site
node --test auth.test.mjs buffer.test.mjs guest-http.test.mjs guest-link.test.mjs password.test.mjs quick-return.test.mjs rail.test.mjs switch.test.mjs theater.test.mjs
```
