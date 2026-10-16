# 🛡️ Guia de Implantação do Webhook em VPS com Sites Existentes (Ubuntu 24.04 LTS)

Como a sua VPS **já está em produção com outros 2 sites ativos**, você já tem o ambiente base configurado (Nginx, SSL/Certbot, Node.js, PM2 e Firewall).

Este guia foca **exclusivamente na adição isolada do microsserviço de Webhook**, garantindo **zero impacto** e **100% de segurança** para os sites que já estão no ar.

---

## 📋 Resumo do que faremos
1. **Verificar a porta disponível** (garantir que a porta `3001` não conflite com seus outros sites).
2. **Deploy do código** em uma pasta dedicada.
3. **Adicionar ao PM2** sem reiniciar ou parar os outros processos.
4. **Criar um novo Server Block no Nginx** exclusivo para o subdomínio do webhook.
5. **Gerar o SSL no Certbot** apenas para o novo subdomínio.
6. **Configurar o Endpoint na Stripe**.

---

## Passo 1: Verificar a Porta Livre na VPS

Acesse a VPS via SSH e confira se a porta padrão `3001` está livre:
```bash
sudo ss -tulpn | grep 3001
# ou
sudo lsof -i :3001
```
- Se o comando **não retornar nada**, a porta `3001` está livre!
- Se já estiver em uso por algum dos outros sites, basta escolher outra porta livre (ex: `3005`, `4000`, `5000`) e alterar no arquivo `.env`.

---

## Passo 2: Subir para o GitHub e Clonar na VPS

A forma mais profissional e segura de levar o código para uma VPS remota é através de um **Repositório Privado no GitHub** utilizando uma **Deploy Key (Chave SSH exclusiva de leitura)**. Assim você nunca expõe sua senha nem seu token pessoal na VPS.

### 2.1 No seu Computador (Criar e subir o repositório privado)

1. Crie um novo repositório **Privado** no GitHub (ex: `stripe-webhook`).
2. No seu computador, abra o terminal dentro da pasta `webhook-service`:
   ```bash
   cd webhook-service
   git init
   git add .
   git commit -m "feat: inicializando servico de webhook stripe"
   git branch -M main
   git remote add origin git@github.com:SEU_USUARIO/SEU_REPOSITORIO.git
   git push -u origin main
   ```
   *(Nota: O arquivo `.gitignore` que criamos já impede que `.env` ou `node_modules` sejam enviados).*

---

### 2.2 Na sua VPS (Configurar Deploy Key e Clonar)

Acesse a VPS via SSH:

#### 1. Gerar uma chave SSH exclusiva para este repositório:
```bash
ssh-keygen -t ed25519 -C "vps-stripe-webhook"
```
*(Pressione `Enter` em todas as perguntas para salvar no caminho padrão sem senha).*

#### 2. Visualizar a chave pública gerada:
```bash
cat ~/.ssh/id_ed25519.pub
```
Copie todo o texto exibido (começa com `ssh-ed25519 ...`).

#### 3. Adicionar no GitHub:
1. Vá até o seu repositório no GitHub.
2. Clique em **Settings** > **Deploy keys** (no menu lateral esquerdo).
3. Clique em **Add deploy key**.
4. **Title:** `VPS Remota`
5. **Key:** Cole a chave pública copiada no terminal.
6. *(Deixe a opção "Allow write access" desmarcada para máxima segurança — a VPS só precisa ler o código).*
7. Clique em **Add key**.

#### 4. Clonar o repositório na VPS:
```bash
# Escolha a pasta padrão onde ficam seus sites (ex: /var/www/)
cd /var/www

# Clone o repositório privado
git clone git@github.com:SEU_USUARIO/SEU_REPOSITORIO.git stripe-webhook
cd stripe-webhook
```

#### 5. Instalar dependências e compilar:
```bash
npm install
npm run build
```

#### 6. Criar o arquivo `.env` de produção na VPS:
```bash
nano .env
```
*(Cole suas variáveis de ambiente: `PORT=3001`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `MONGODB_URI`, `DISCORD_TOKEN`).*

Proteja o arquivo `.env` para que apenas seu usuário possa ler:
```bash
chmod 600 .env
```

> 💡 **Dica para atualizações futuras:** Quando você fizer qualquer alteração no código no seu PC e der `git push`, basta rodar na VPS:
> ```bash
> cd /var/www/stripe-webhook && git pull && npm run build && pm2 restart stripe-webhook
> ```

---

## Passo 3: Iniciar no PM2 (Sem afetar os outros sites)

O PM2 suporta múltiplas aplicações rodando simultaneamente. Vamos apenas registrar e iniciar este novo processo:

```bash
pm2 start ecosystem.config.js
pm2 save
```

Verifique o status de todas as aplicações (seus outros sites continuarão rodando normalmente):
```bash
pm2 list
```

Para ver os logs apenas deste serviço:
```bash
pm2 logs stripe-webhook
```

---

## Passo 4: Adicionar o Novo Subdomínio no Nginx

> ⚠️ **Atenção:** Como você já tem outros sites no Nginx, **NUNCA** delete ou edite os arquivos dos outros sites em `/etc/nginx/sites-enabled/`. Criaremos um arquivo 100% novo e separado.

### 4.1 Apontamento DNS
No painel do seu domínio (Cloudflare, Registro.br, etc.), crie um apontamento tipo **A**:
- **Nome:** `webhook` (ou o prefixo que preferir, ex: `vip-api`)
- **Valor:** O endereço IP da sua VPS

### 4.2 Criar o arquivo de configuração no Nginx
```bash
sudo nano /etc/nginx/sites-available/stripe-webhook
```

Cole a configuração abaixo (substitua `webhook.seudominio.com` pelo seu subdomínio real):

```nginx
# Rate limiting para proteger o endpoint de webhook contra ataques DoS
limit_req_zone $binary_remote_addr zone=stripe_limit:10m rate=15r/s;

server {
    listen 80;
    server_name webhook.seudominio.com; # <-- Coloque seu subdomínio aqui

    # Cabeçalhos de segurança HTTP
    add_header X-Frame-Options "DENY" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    # Limita o payload máximo da requisição para 2MB
    client_max_body_size 2M;

    # Rota do Webhook da Stripe
    location /webhook {
        limit_req zone=stripe_limit burst=20 nodelay;

        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_read_timeout 60s;
        proxy_connect_timeout 15s;
    }

    # Rota de Health Check para teste rápido
    location /health {
        proxy_pass http://127.0.0.1:3001;
    }

    # Bloqueia qualquer rota não existente
    location / {
        return 404;
    }
}
```

### 4.3 Ativar apenas o novo site
```bash
# Cria o link simbólico para ativar o novo site
sudo ln -s /etc/nginx/sites-available/stripe-webhook /etc/nginx/sites-enabled/

# Testa se a sintaxe de todos os sites está válida (NÃO recarrega se houver erro)
sudo nginx -t

# Recarrega o Nginx de forma suave (sem derrubar conexões ativas dos outros sites)
sudo systemctl reload nginx
```

---

## Passo 5: Gerar o Certificado SSL (Apenas para o novo subdomínio)

O Certbot adiciona o SSL ao novo subdomínio sem encostar nos certificados dos seus outros 2 sites:

```bash
sudo certbot --nginx -d webhook.seudominio.com
```

O Certbot irá:
1. Validar o novo subdomínio.
2. Gerar o certificado Let's Encrypt.
3. Inserir a configuração de HTTPS e redirecionamento 301 automaticamente no arquivo `/etc/nginx/sites-available/stripe-webhook`.

Teste se o endpoint está respondendo com HTTPS:
```bash
curl -I https://webhook.seudominio.com/health
# Retorno esperado: HTTP/2 200 (ou HTTP/1.1 200 OK)
```

---

## Passo 6: Cadastrar o Webhook no Dashboard da Stripe

1. Abra o **[Dashboard da Stripe](https://dashboard.stripe.com)**.
2. Vá em **Desenvolvedores** > **Webhooks**.
3. Clique em **+ Adicionar endpoint**.
4. **URL do endpoint:** `https://webhook.seudominio.com/webhook`
5. **Eventos a escutar:**
   - ✅ `checkout.session.completed` *(ativa o VIP avulso ou assinatura assim que o pagamento é aprovado)*
   - ✅ `invoice.payment_succeeded` *(renova o VIP nas cobranças mensais recorrentes)*
   - ✅ `customer.subscription.deleted` *(remove o cargo VIP no Discord caso a assinatura seja cancelada)*
   - ✅ `customer.subscription.updated` *(detecta cancelamento agendado para o fim do ciclo)*
6. Salve o endpoint.
7. Clique em **Revelar** no campo **Segredo de assinatura** (`whsec_...`).
8. Cole o valor no arquivo `.env` da VPS na variável `STRIPE_WEBHOOK_SECRET`.
9. Reinicie apenas este serviço no PM2:
   ```bash
   pm2 restart stripe-webhook
   ```

---

## 🔍 Comandos de Monitoramento

- **Ver logs em tempo real das notificações da Stripe:**
  ```bash
  pm2 logs stripe-webhook
  ```
- **Reiniciar o serviço:**
  ```bash
  pm2 restart stripe-webhook
  ```
- **Testar se o serviço está respondendo localmente:**
  ```bash
  curl http://127.0.0.1:3001/health
  # Retorna: {"status":"ok","timestamp":"..."}
  ```
