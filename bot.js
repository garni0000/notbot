import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import { MongoClient } from 'mongodb';
import http from 'http';
import pLimit from 'p-limit';

// Chargement des variables d'environnement
const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGO_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME || 'solkahbot';
const COLLECTION_NAME = process.env.COLLECTION_NAME || 'vxuser';
const ADMIN_ID = parseInt(process.env.ADMIN_ID, 10);
const CHANNEL_LINK = process.env.CHANNEL_LINK;

// Vérification des .env
if (!BOT_TOKEN || !MONGO_URI || !ADMIN_ID) {
  console.error('🔥 Variables .env manquantes ! Assurez-vous de définir BOT_TOKEN, MONGODB_URI, ADMIN_ID.');
  process.exit(1);
}

// Initialisation du bot et de la DB
const bot = new Telegraf(BOT_TOKEN);
const client = new MongoClient(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
let usersCollection;

async function connectDb() {
  try {
    await client.connect();
    usersCollection = client.db(DB_NAME).collection(COLLECTION_NAME);
    console.log('✔️ Connecté à MongoDB');
  } catch (err) {
    console.error('❌ Erreur de connexion MongoDB:', err);
    process.exit(1);
  }
}

// Middleware: enregistrer l'utilisateur à chaque interaction
bot.use(async (ctx, next) => {
  if (!usersCollection) return next();
  if (ctx.from && ctx.message) {
    const userId = ctx.from.id;
    const now = new Date();
    await usersCollection.updateOne(
      { id: userId },
      { $setOnInsert: { id: userId, first_name: ctx.from.first_name || '', username: ctx.from.username || '', joined_at: now } },
      { upsert: true }
    );
  }
  return next();
});

// /start: message de bienvenue + bouton inline
bot.start(async (ctx) => {
  const name = ctx.from.first_name || ctx.from.username || 'ami';
  return ctx.reply(
    `Salut ${name}! Bienvenue dans le programme hack de solkah.\nClique vite sur le bouton ci-dessous pour profiter des hacks ultra rentables 💸\nLes places sont limitées, fais ta demande maintenant 👇👇👇👇`,
    Markup.inlineKeyboard([Markup.button.url('Rejoindre✅🤑', CHANNEL_LINK)])
  );
});

// /stats: total, ce mois, 3 derniers mois (admin only)
bot.command('stats', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;

  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const threeMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 2, 1);

  const [totalUsers, monthCount, last3Count] = await Promise.all([
    usersCollection.countDocuments(),
    usersCollection.countDocuments({ joined_at: { $gte: startOfMonth } }),
    usersCollection.countDocuments({ joined_at: { $gte: threeMonthsAgo } })
  ]);

  await ctx.replyWithHTML(
    `📊 <b>Stats Solkah Traffic</b>:\n👥 Total utilisateurs: <b>${totalUsers}</b>\n📅 Ce mois-ci: <b>${monthCount}</b>\n🗓️ 3 derniers mois: <b>${last3Count}</b>`
  );
});

// Sessions de broadcast pour l'admin
const broadcastSessions = new Map();

bot.command('ads', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const total = await usersCollection.countDocuments();
  broadcastSessions.set(ctx.from.id, { stage: 'awaiting_content', total });
  return ctx.reply(`🚀 Vous allez diffuser à ${total} utilisateurs. Envoyez maintenant le contenu (texte, photo, video, etc.).`);
});

// Capture du contenu à diffuser
bot.on(['text', 'photo', 'video', 'audio', 'document', 'voice'], async (ctx) => {
  const session = broadcastSessions.get(ctx.from.id);
  if (!session || session.stage !== 'awaiting_content') return;

  session.content = { message_id: ctx.message.message_id, chat_id: ctx.chat.id };
  session.stage = 'awaiting_confirm';

  return ctx.reply(
    '❓ Confirmer la diffusion ?',
    Markup.inlineKeyboard([
      Markup.button.callback('✅ Oui', 'broadcast_confirm'),
      Markup.button.callback('❌ Non', 'broadcast_cancel')
    ])
  );
});

// Confirmation ou annulation
bot.action('broadcast_confirm', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery();
  const session = broadcastSessions.get(ctx.from.id);
  if (!session || session.stage !== 'awaiting_confirm') return ctx.answerCbQuery();

  session.stage = 'broadcasting';
  await ctx.editMessageText('🔄 Lancement de la diffusion...');
  broadcastContent(ctx, session).catch(console.error);
  return ctx.answerCbQuery();
});

bot.action('broadcast_cancel', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery();
  broadcastSessions.delete(ctx.from.id);
  await ctx.editMessageText('❌ Diffusion annulée.');
  return ctx.answerCbQuery();
});

// Fonction de diffusion avec copyMessage et suivi des stats
async function broadcastContent(ctx, session) {
  const limit = pLimit(20);
  const usersCursor = usersCollection.find({}, { projection: { id: 1 } });

  let success = 0, failed = 0, sent = 0;
  const startTime = Date.now();
  const statusMsg = await ctx.reply(`✅: 0 | ❌: 0 | 0 msg/s`);

  const tasks = [];
  while (await usersCursor.hasNext()) {
    const user = await usersCursor.next();
    tasks.push(limit(async () => {
      try {
        await ctx.telegram.copyMessage(user.id, session.content.chat_id, session.content.message_id);
        success++;
      } catch {
        failed++;
      } finally {
        sent++;
        if (sent % 20 === 0) {
          const elapsed = (Date.now() - startTime) / 1000;
          const rate = (sent / elapsed).toFixed(2);
          try {
            await ctx.telegram.editMessageText(
              ctx.chat.id,
              statusMsg.message_id,
              null,
              `✅: ${success} | ❌: ${failed} | ${rate} msg/s`
            );
          } catch {}
        }
      }
    }));
  }

  await Promise.all(tasks);
  const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
  await ctx.telegram.editMessageText(
    ctx.chat.id,
    statusMsg.message_id,
    null,
    `🎉 Terminé ! Total ✅: ${success} | ❌: ${failed} | en ${totalTime}s`
  );
  broadcastSessions.delete(ctx.from.id);
}

// Gestion des erreurs non capturées
process.on('uncaughtException', (err) => {
  console.error('Erreur non capturée:', err);
});




// --- Serveur HTTP ---
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end("Bot actif");
});
server.listen(8080, () => console.log("🌍 Port 8080"));
