require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { MongoClient } = require('mongodb');
const http = require('http');
let PLimit;
import('p-limit').then(module => {
  PLimit = module.default;
});

// Configuration et constantes
const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGO_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME || 'solkah_traffic';
const COLLECTION_NAME = process.env.COLLECTION_NAME || 'user_solkah';
const ADMIN_ID = parseInt(process.env.ADMIN_ID, 10);
const CHANNEL_LINK = process.env.CHANNEL_LINK || 'https://t.me/+omaJ1VufdHs1NGZk';

if (!BOT_TOKEN || !MONGO_URI || !ADMIN_ID) {
  console.error('🔥 Variables .env manquantes ! Assurez-vous de définir BOT_TOKEN, MONGODB_URI, ADMIN_ID.');
  process.exit(1);
}

// Initialisation du bot et de la DB
const bot = new Telegraf(BOT_TOKEN);
let dbClient;
let usersCollection;

async function connectDb() {
  dbClient = new MongoClient(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
  await dbClient.connect();
  usersCollection = dbClient.db(DB_NAME).collection(COLLECTION_NAME);
  console.log('✔️ Connecté à MongoDB');
}

// Middleware: enregistrer l'utilisateur à la première interaction
bot.use(async (ctx, next) => {
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
    `Salut ${name}! Bienvenue dans le programme hack de solkah.\nCliquez sur le bouton ci-dessous pour nous rejoindre et débloquer ton accès dans le canal réservé aux personnes ambitieuses et prêtes à réussir 💎`,
    Markup.inlineKeyboard([
      Markup.button.url('Rejoindre✅🤑', CHANNEL_LINK)
    ])
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
    `📊 <b>Stats Solkah Traffic</b>:
👥 Total utilisateurs: <b>${totalUsers}</b>
📅 Ce mois-ci: <b>${monthCount}</b>
🗓️ 3 derniers mois: <b>${last3Count}</b>`
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
  if (!PLimit) {
    PLimit = (await import('p-limit')).default;
  }
  const limit = PLimit(20);
  const usersCursor = usersCollection.find({}, { projection: { id: 1 } });

  let success = 0, failed = 0, sent = 0;
  const startTime = Date.now();
  const statusMsg = await ctx.reply(`✅: 0 | ❌: 0 | 0 msg/s`);

  const tasks = [];
  const total = session.total;

  while (await usersCursor.hasNext()) {
    const user = await usersCursor.next();
    tasks.push(limit(async () => {
      try {
        await ctx.telegram.copyMessage(user.id, session.content.chat_id, session.content.message_id);
        success++;
      } catch (err) {
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

// Démarrage du bot
(async () => {
  await connectDb();
  bot.launch();
  console.log('🤖 Bot Solkah démarré');
})();
// Démarrage du bot et création du serveur HTTP
bot.launch()
  .then(() => console.log('🚀 Bot démarré !'))
  .catch(err => {
    console.error('❌ Erreur de démarrage:', err);
    process.exit(1);
  });

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot en ligne');
}).listen(8080);
