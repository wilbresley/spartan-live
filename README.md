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

`build.ps1` instala o empacotador, gera `publisher\dist\SpartanLive.exe` e grava o ícone do projeto. O `publish.json` entra no executável com o usuário e a senha de transmitir. O campo de servidor sai vazio.

`make_icon.py` regrava `assets\Spartan-Live.ico`. O build usa o ícone que já está no repositório.

Para o botão Download da página, no servidor:

```sh
mkdir -p download
cp /caminho/SpartanLive.exe download/SpartanLive.exe
```

O site entrega só esse arquivo, e só com sessão.

### Uso

O programa pede apelido, servidor, monitor, som do PC, microfone e a qualidade. O padrão é 1080p 60. A janela tem 560×720, sem borda, e abre no centro do monitor principal.

O apelido tem 2 a 24 caracteres: letras, números, `_` e `-`. Ele é o nome da live.

O campo Servidor aceita IPv4 ou domínio, sem `http://`. O programa remove esquema, caminho e porta escritos ali. O RTMP usa a porta do `publish.json`, 1935. Um IP avisa o site em `http://IP:8097`. Um domínio tenta `https://dominio` e, se falhar, `http://dominio:8097`.

Apelido, servidor, qualidade, monitor e aparelhos ficam em `%APPDATA%\SpartanLive\config.json`. O log fica em `%APPDATA%\SpartanLive\spartan.log`, por 30 dias, sem senha. A pasta temporária do executável só descompacta o programa.

O som do PC começa no alto-falante padrão. Dá para trocar o som ou o microfone com a live aberta quando ela começou com algum áudio. Os dois em "Sem som" deixam a transmissão sem canal de áudio até a próxima abertura.

Trocar de monitor durante a live reinicia só a captura, no mesmo apelido. A página mostra "Trocando tela!" e segue na ponta.

Minimizar vai para a bandeja. Parado, o ícone é `assets/Spartan-Live.ico`. Transmitindo, `assets/Spartan-Live-ON.ico`. "Abrir com o Windows, sem iniciar a live" só registra o executável. A live não começa sozinha.

### Codificação

O encoder usado é o primeiro que responder, nesta ordem: `h264_nvenc`, `h264_amf`, `h264_qsv`, `libx264`. GOP igual à taxa de quadros, sem quadros B, CBR, `bufsize` com o dobro da taxa. No processador, o preset é `veryfast`, e `ultrafast` em 720p 60.

| Qualidade | Placa | Processador |
| --- | ---: | ---: |
| 1080p 60 | 14 Mbps | 12 Mbps |
| 1080p 30 | 8 Mbps | 8 Mbps |
| 720p 60 | 8 Mbps | 6 Mbps |
| 720p 30 | 5 Mbps | 4 Mbps |

A tela entra por `gdigrab`, o monitor inteiro, com o cursor. O vídeo segue sozinho em MPEG-TS. O som do PC e o microfone são lidos no Windows, reamostrados com soxr para 48 kHz estéreo, somados em ponto flutuante e entregues em blocos de 20 ms. O segundo processo copia o vídeo e grava AAC a 256 kbps. O deslocamento na junção é zero.

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

Um apelido na lista coloca o quadro parado. O vídeo só baixa no play. Clicar de novo no apelido, ou no X do quadro, remove o player. O X não encerra a transmissão.

Uma live ocupa a área. Duas ou mais ficam em duas colunas iguais, com a imagem inteira no quadro. Clicar no quadro amplia. Clicar de novo, ou Esc, volta à grade. A grade e cada quadro têm tela cheia.

A reprodução começa muda. O volume vai de 0 a 100, de 5 em 5. Mutar guarda o último nível.

**Ao vivo** pula para a ponta. Fica verde com atraso de até 7 segundos e vermelho acima disso. Quem está tocando e passa de 90 segundos atrás volta para a ponta. Uma pausa de 5 minutos ou mais também recomece na ponta.

Parar no programa, ou fechar a janela, avisa o servidor e o apelido sai na hora. Uma queda espera 90 segundos, com o quadro em "Offline. Aguardando a reconexão." Se a pessoa volta, o player reabre na ponta.

Os sons de entrada e de saída tocam depois do login. A entrada marca uma live que começou. A saída marca uma parada, ou uma queda que passou de 90 segundos. Cada um espera 3 minutos antes de repetir o mesmo apelido. O botão em Ajustes liga e desliga os dois. Ajustes também troca a senha da página e baixa o programa.

## Segurança

A senha da página é scrypt. O cookie de sessão é HttpOnly. Em HTTPS ele também é Secure. Oito senhas erradas no mesmo IP bloqueiam esse IP por 5 minutos.

`X-Forwarded-For` só é aceito quando o pedido chega de um proxy local. Acesso direto na 8097 não escolhe o próprio IP.

O HLS e a lista exigem sessão. Publicar, parar, trocar de tela e enviar a miniatura exigem o usuário e a senha do `publish.json`, distintos do login da página. O nome da live só aceita o mesmo conjunto do apelido.

Ficam fora do git: `.env`, `motor/mediamtx.yml`, `publisher/publish.json`, `publisher/dist/`, `publisher/ffmpeg/`, `publisher/build/` e `download/`.

## Testes

```sh
cd publisher
python -m unittest test_spartan_live.py
```

```sh
cd site
node --test auth.test.mjs buffer.test.mjs password.test.mjs rail.test.mjs switch.test.mjs
```
