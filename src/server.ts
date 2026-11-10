import "dotenv/config";
import express, { Request, Response } from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import Stripe from "stripe";
import mongoose, { Schema, model } from "mongoose";
import { REST } from "@discordjs/rest";
import { Routes } from "discord-api-types/v10";

// ── 1. Validação de Variáveis de Ambiente ────────────────────────────────────
const {
  PORT = "3001",
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  MONGODB_URI,
  DISCORD_TOKEN,
} = process.env;

if (!STRIPE_SECRET_KEY) throw new Error("STRIPE_SECRET_KEY não definida no .env");
if (!STRIPE_WEBHOOK_SECRET) throw new Error("STRIPE_WEBHOOK_SECRET não definida no .env");
if (!MONGODB_URI) throw new Error("MONGODB_URI não definida no .env");
if (!DISCORD_TOKEN) throw new Error("DISCORD_TOKEN não definida no .env");

// ── 2. Clientes Stripe e Discord REST ────────────────────────────────────────
const stripe = new Stripe(STRIPE_SECRET_KEY, {
  apiVersion: "2024-09-30.acacia" as any,
});

const discordRest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

// ── 3. Modelos Mongoose Locais (Compatíveis com o Bot) ───────────────────────
const VipSubscriptionSchema = new Schema(
  {
    guildId: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    tierId: { type: String, required: true },
    roleId: { type: String, required: true },
    type: { type: String, enum: ["subscription", "one_time"], required: true },
    status: {
      type: String,
      enum: ["active", "canceled", "expired", "past_due"],
      default: "active",
      index: true,
    },
    stripeCustomerId: { type: String, default: null, index: true },
    stripeSubscriptionId: { type: String, default: null, index: true },
    stripeSessionId: { type: String, default: null },
    currentPeriodEnd: { type: Date, required: true, index: true },
    cancelAtPeriodEnd: { type: Boolean, default: false },
  },
  { timestamps: true }
);
const VipSubscription = model("VipSubscription", VipSubscriptionSchema);

const VipShopConfigSchema = new Schema(
  {
    guildId: { type: String, required: true, unique: true },
    title: { type: String },
    description: { type: String },
    bannerUrl: { type: String, default: null },
    shopChannelId: { type: String, default: null },
    shopMessageId: { type: String, default: null },
    logChannelId: { type: String, default: null },
    enabled: { type: Boolean, default: true },
  },
  { timestamps: true }
);
const VipShopConfig = model("VipShopConfig", VipShopConfigSchema);

// ── 4. Funções Auxiliares do Discord REST ────────────────────────────────────
async function addDiscordRole(guildId: string, userId: string, roleId: string) {
  try {
    await discordRest.put(Routes.guildMemberRole(guildId, userId, roleId), {
      reason: "VIP Ativado via Stripe",
    });
    console.log(`[Discord] ✅ Cargo ${roleId} concedido com sucesso para ${userId}.`);
  } catch (error: any) {
    console.error(`[Discord] ❌ Falha ao adicionar cargo ${roleId} para ${userId}:`, error?.message || error);
    if (error?.status === 403) {
      console.error("[Discord] ⚠️ DICA DE PERMISSÃO: Verifique se o Bot tem a permissão 'Gerenciar Cargos' e se o cargo do Bot está ACIMA do cargo VIP na hierarquia do servidor!");
    }
  }
}

async function removeDiscordRole(guildId: string, userId: string, roleId: string) {
  try {
    await discordRest.delete(Routes.guildMemberRole(guildId, userId, roleId), {
      reason: "VIP Cancelado ou Expirado via Stripe",
    });
    console.log(`[Discord] Cargo ${roleId} removido de ${userId}.`);
  } catch (error) {
    console.error(`[Discord] Falha ao remover cargo ${roleId} de ${userId}:`, error);
  }
}

async function sendLogEmbed(guildId: string, embed: any) {
  try {
    const config = await VipShopConfig.findOne({ guildId });
    if (!config || !config.logChannelId) return;

    await discordRest.post(Routes.channelMessages(config.logChannelId), {
      body: { embeds: [embed] },
    });
  } catch (error) {
    console.error("[Discord] Falha ao enviar embed de log:", error);
  }
}

async function sendUserDm(userId: string, embed: any) {
  try {
    const dmChannel = (await discordRest.post(Routes.userChannels(), {
      body: { recipient_id: userId },
    })) as { id: string };

    await discordRest.post(Routes.channelMessages(dmChannel.id), {
      body: { embeds: [embed] },
    });
  } catch {
    // DMs bloqueadas pelo usuário
  }
}

// ── 5. Servidor Express com Proteções de Segurança ───────────────────────────
const app = express();

// Proteção de Cabeçalhos HTTP
app.use(helmet());

// Limite de Requisições contra DoS (1000 requisições por 15 minutos por IP)
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Muitas requisições, tente novamente mais tarde." },
});
app.use(limiter);

// Health check para monitoramento (ex: Uptime Kuma, Nginx)
app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
});

// Endpoint Oficial do Webhook da Stripe
// IMPORTANTE: o corpo DEVE ser mantido como Buffer bruto (raw) para validação criptográfica!
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req: Request, res: Response) => {
    const sig = req.headers["stripe-signature"];

    if (!sig) {
      console.warn("[Webhook] Requisição recebida sem cabeçalho stripe-signature.");
      res.status(400).send("Assinatura do Stripe ausente.");
      return;
    }

    let event: Stripe.Event;

    try {
      // Validação Criptográfica rigorosa da assinatura da Stripe
      event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    } catch (err: any) {
      console.error(`[Webhook] ❌ Falha na verificação da assinatura: ${err.message}`);
      res.status(400).send(`Webhook Error: ${err.message}`);
      return;
    }

    console.log(`[Webhook] 🔔 Evento recebido: ${event.type} (${event.id})`);

    try {
      switch (event.type) {
        // ── 1. Pagamento / Checkout Concluído (Assinatura ou Avulso Pix/Cartão) ──
        case "checkout.session.completed": {
          const session = event.data.object as Stripe.Checkout.Session;
          const meta = session.metadata || {};

          const guildId = meta.guild_id;
          const userId = meta.user_id;
          const tierId = meta.tier_id;
          const roleId = meta.role_id;
          const purchaseType = (meta.purchase_type || "one_time") as "subscription" | "one_time";
          const durationDays = parseInt(meta.duration_days || "30", 10);

          if (!guildId || !userId || !roleId) {
            console.warn("[Webhook] Sessão de checkout sem metadados suficientes:", session.id);
            res.status(200).json({ received: true, warning: "Missing metadata" });
            return;
          }

          let currentPeriodEnd = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000);

          if (purchaseType === "subscription" && session.subscription) {
            try {
              const subObj = await stripe.subscriptions.retrieve(String(session.subscription));
              if (subObj && (subObj as any).current_period_end) {
                currentPeriodEnd = new Date((subObj as any).current_period_end * 1000);
              }
            } catch (subErr: any) {
              console.warn(`[Webhook] Não foi possível consultar assinatura no Stripe (${session.subscription}):`, subErr?.message);
              console.log(`[Webhook] Usando período padrão de ${durationDays} dias como fallback.`);
            }
          }

          // Atualiza ou Cria a Assinatura no Banco
          try {
            await VipSubscription.findOneAndUpdate(
              { guildId, userId, tierId },
              {
                $set: {
                  guildId,
                  userId,
                  tierId,
                  roleId,
                  type: purchaseType,
                  status: "active",
                  stripeCustomerId: session.customer ? String(session.customer) : null,
                  stripeSubscriptionId: session.subscription ? String(session.subscription) : null,
                  stripeSessionId: session.id,
                  currentPeriodEnd,
                  cancelAtPeriodEnd: false,
                },
                $inc: { monthsSubscribed: 1 },
              },
              { upsert: true, new: true }
            );
            console.log(`[Banco] Assinatura salva com sucesso para ${userId} (Guild: ${guildId}, Tier: ${tierId}).`);
          } catch (dbErr) {
            console.error("[Banco] Erro ao salvar assinatura no MongoDB:", dbErr);
          }

          // Atribui o cargo no Discord imediatamente
          await addDiscordRole(guildId, userId, roleId);

          // Envia notificação no canal de logs da Staff
          const endTs = Math.floor(currentPeriodEnd.getTime() / 1000);
          try {
            await sendLogEmbed(guildId, {
              title: "🎉 Novo VIP Ativado!",
              color: 0x00ff88,
              description: `O usuário <@${userId}> adquiriu o VIP **${tierId}**!`,
              fields: [
                { name: "Tipo", value: purchaseType === "subscription" ? "Assinatura Mensal" : `Avulso (${durationDays} dias)`, inline: true },
                { name: "Expiração / Próx. Fatura", value: `<t:${endTs}:f>`, inline: true },
                { name: "Cargo Entregue", value: `<@&${roleId}>`, inline: true },
              ],
              timestamp: new Date().toISOString(),
            });
          } catch (logErr) {
            console.warn("[Discord] Falha ao enviar log de staff:", logErr);
          }

          // Notifica o usuário por DM
          try {
            await sendUserDm(userId, {
              title: "🌟 Seu VIP foi Ativado com Sucesso!",
              color: 0x00ff88,
              description: `Parabéns! Seu benefício VIP **${tierId}** foi ativado no servidor. O seu cargo já foi entregue automaticamente!\n\n` +
                `• **Válido até:** <t:${endTs}:f> (<t:${endTs}:R>)\n\n` +
                `Agradecemos imensamente por apoiar nossa comunidade!`,
              timestamp: new Date().toISOString(),
            });
          } catch (dmErr) {
            // Ignora se DM estiver fechada
          }

          break;
        }

        // ── 2. Renovação de Fatura de Assinatura Recorrente Aprovada ────────────
        case "invoice.payment_succeeded": {
          const invoice = event.data.object as Stripe.Invoice;
          const subId = (invoice as any).subscription;

          if (!subId) break;

          const existingSub = await VipSubscription.findOne({ stripeSubscriptionId: String(subId) });
          if (!existingSub) break;

          // Atualiza a data do novo período
          const subObj = await stripe.subscriptions.retrieve(String(subId));
          existingSub.currentPeriodEnd = new Date(subObj.current_period_end * 1000);
          existingSub.status = "active";
          await existingSub.save();

          // Garante que o cargo continue com o usuário
          await addDiscordRole(existingSub.guildId, existingSub.userId, existingSub.roleId);

          const endTs = Math.floor(existingSub.currentPeriodEnd.getTime() / 1000);
          await sendLogEmbed(existingSub.guildId, {
            title: "🔄 Assinatura VIP Renovada",
            color: 0x3498db,
            description: `A assinatura de <@${existingSub.userId}> foi renovada com sucesso para o próximo mês.`,
            fields: [{ name: "Próxima Fatura", value: `<t:${endTs}:f>`, inline: true }],
            timestamp: new Date().toISOString(),
          });

          break;
        }

        // ── 3. Assinatura Recorrente Cancelada / Encerrada ──────────────────────
        case "customer.subscription.deleted": {
          const sub = event.data.object as Stripe.Subscription;
          const existingSub = await VipSubscription.findOne({ stripeSubscriptionId: sub.id });

          if (!existingSub) break;

          existingSub.status = "canceled";
          await existingSub.save();

          // Remove o cargo no Discord
          await removeDiscordRole(existingSub.guildId, existingSub.userId, existingSub.roleId);

          await sendLogEmbed(existingSub.guildId, {
            title: "🛑 Assinatura VIP Cancelada",
            color: 0xff4444,
            description: `A assinatura de <@${existingSub.userId}> foi encerrada no Stripe e o cargo <@&${existingSub.roleId}> foi removido.`,
            timestamp: new Date().toISOString(),
          });

          await sendUserDm(existingSub.userId, {
            title: "Assinatura VIP Encerrada",
            color: 0xff4444,
            description: `Sua assinatura VIP foi cancelada e o cargo removido. Esperamos vê-lo de volta em breve!`,
            timestamp: new Date().toISOString(),
          });

          break;
        }

        // ── 4. Atualização de Assinatura (ex: cancelamento programado no fim do período) ─
        case "customer.subscription.updated": {
          const sub = event.data.object as Stripe.Subscription;
          const existingSub = await VipSubscription.findOne({ stripeSubscriptionId: sub.id });

          if (existingSub) {
            existingSub.cancelAtPeriodEnd = sub.cancel_at_period_end;
            if (sub.cancel_at_period_end) {
              const endTs = Math.floor(sub.current_period_end);
              console.log(`[Stripe] Assinatura de ${existingSub.userId} cancelada para o fim do período (<t:${endTs}:f>).`);
            }
            await existingSub.save();
          }
          break;
        }

        default:
          // Outros eventos não exigem ação imediata
          break;
      }

      res.status(200).json({ received: true });
    } catch (err: any) {
      console.error("[Webhook] Erro ao processar evento:", err);
      res.status(500).send("Erro interno ao processar webhook.");
    }
  }
);

// ── 6. Inicialização do Servidor ─────────────────────────────────────────────
async function startServer() {
  console.log("[MongoDB] Conectando ao banco de dados...");
  await mongoose.connect(MONGODB_URI!);
  console.log("[MongoDB] Conectado com sucesso!");

  app.listen(parseInt(PORT, 10), "0.0.0.0", () => {
    console.log(`\n==================================================`);
    console.log(`🚀 Webhook Service rodando na porta ${PORT}`);
    console.log(`🔒 Rota segura do Stripe: POST /webhook`);
    console.log(`💚 Rota de Health Check: GET /health`);
    console.log(`==================================================\n`);
  });
}

startServer().catch((err) => {
  console.error("[Server] Erro fatal na inicialização:", err);
  process.exit(1);
});
