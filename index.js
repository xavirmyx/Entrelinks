const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const cron = require('node-cron');
const axios = require('axios');
const cheerio = require('cheerio');

// Token del bot y nombre
const token = '7861676131:AAFLv4dBIFiHV1OYc8BJH2U8kWPal7lpBMQ';
const bot = new TelegramBot(token);
const botName = 'EntreCheck_iptv';

// Configuración de Express
const app = express();
const port = process.env.PORT || 10000;
app.use(express.json());

// Webhook (usado en Render)
const webhookUrl = 'https://entrelinks.onrender.com';

// IDs permitidos
const ALLOWED_CHAT_IDS = [
  { chatId: '-1002348662107', threadId: '53411', name: 'EntresHijos' },
  { chatId: '-1002565012502', threadId: null, name: 'BotChecker_IPTV_ParaG' }
];

// Almacenar datos
let userHistory = {};
let userStates = {};
let userConfigs = {};

// Mensaje fijo
const adminMessage = '\n\n👨‍💼 *Equipo de Administración EntresHijos*';

// Registrar logs
function logAction(action, details) {
  const timestamp = new Date().toLocaleString('es-ES');
  console.log(`[${timestamp}] ${action}:`, details);
}

// Escapar caracteres para Markdown
function escapeMarkdown(text) {
  return text.replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

// Obtener mención del usuario
function getUserMention(user) {
  return user.username ? `@${escapeMarkdown(user.username)}` : escapeMarkdown(user.first_name);
}

// Autoeliminar mensaje después de 5 minutos
async function autoDeleteMessage(chatId, messageId, threadId) {
  setTimeout(async () => {
    try {
      await bot.deleteMessage(chatId, messageId);
    } catch (error) {
      logAction('delete_message_error', { chatId, messageId, error: error.message });
    }
  }, 300000);
}

// Animación de carga (optimizada para rapidez)
async function showLoadingAnimation(chatId, threadId, messageId, baseText) {
  const frames = ['🔍', '⏳', '🔎'];
  let frameIndex = 0;
  const duration = 1000; // 1 segundo
  const interval = 500;
  const steps = Math.floor(duration / interval);

  for (let i = 0; i < steps; i++) {
    const frame = frames[frameIndex % frames.length];
    try {
      await bot.editMessageText(`${baseText} ${frame}`, {
        chat_id: chatId,
        message_id: messageId,
        message_thread_id: threadId === '0' ? undefined : threadId,
        parse_mode: 'Markdown'
      });
    } catch (error) {
      if (error.response?.status === 429) {
        const retryAfter = error.response.data.parameters.retry_after || 1;
        await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
        continue;
      }
      break;
    }
    frameIndex++;
    await new Promise(resolve => setTimeout(resolve, interval));
  }
}

// Ruta webhook (para Render)
app.post(`/bot${token}`, (req, res) => {
  logAction('webhook_received', { update: req.body });
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.get('/', (req, res) => res.send(`${botName} is running`));

// Iniciar servidor
app.listen(port, async () => {
  console.log(`🚀 Servidor en puerto ${port}`);
  await setWebhookWithRetry();
});

// Configurar webhook con reintentos
async function setWebhookWithRetry() {
  try {
    await bot.setWebHook(`${webhookUrl}/bot${token}`);
    logAction('webhook_set', { url: `${webhookUrl}/bot${token}` });
  } catch (error) {
    logAction('webhook_error', { error: error.message });
    if (error.response?.status === 429) {
      const retryAfter = error.response.data.parameters.retry_after || 1;
      await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
      return setWebhookWithRetry();
    }
    console.error('Error al configurar webhook:', error.message);
  }
}

// Verificar contexto
function isAllowedContext(chatId, threadId) {
  const group = ALLOWED_CHAT_IDS.find(g => g.chatId === String(chatId));
  if (!group) return false;
  return group.threadId ? String(threadId) === group.threadId : true;
}

// Obtener threadId permitido
function getAllowedThreadId(chatId) {
  const group = ALLOWED_CHAT_IDS.find(g => g.chatId === String(chatId));
  return group ? group.threadId : null;
}

// Verificar lista IPTV
async function checkIPTVList(url, userId) {
  logAction('check_start', { url });
  try {
    url = url.trim();
    if (!url.startsWith('http')) url = `http://${url}`;
    const timeout = userConfigs[userId]?.timeout || 3000;

    if (url.includes('get.php')) {
      const [, params] = url.split('?');
      const queryParams = Object.fromEntries(new URLSearchParams(params));
      const { username, password } = queryParams;
      const server = url.split('/get.php')[0];
      const apiUrl = `${server}/player_api.php?username=${username}&password=${password}`;

      const response = await axios.get(apiUrl, { timeout });
      const { user_info, server_info } = response.data;
      const streams = await axios.get(`${apiUrl}&action=get_live_streams`, { timeout });

      logAction('check_xtream_success', { url, channels: streams.data.length });
      return {
        type: 'Xtream Codes',
        status: user_info.status === 'Active' ? 'Activa' : 'Inactiva',
        username,
        password,
        server,
        createdAt: user_info.created_at ? new Date(user_info.created_at * 1000).toLocaleDateString('es-ES') : 'Desconocida',
        expiresAt: user_info.exp_date ? new Date(user_info.exp_date * 1000).toLocaleDateString('es-ES') : 'Ilimitada',
        activeConnections: user_info.active_cons,
        maxConnections: user_info.max_connections,
        totalChannels: streams.data.length,
        timezone: server_info.timezone || 'Desconocida'
      };
    }

    if (url.endsWith('.m3u') || url.endsWith('.m3u8')) {
      const response = await axios.get(url, { timeout });
      const lines = response.data.split('\n');
      const channels = [];
      let currentChannel = null;

      for (const line of lines) {
        const trimmedLine = line.trim();
        if (trimmedLine.startsWith('#EXTINF')) {
          const name = trimmedLine.split(',')[1]?.trim() || 'Canal sin nombre';
          currentChannel = { name, url: null };
        } else if (trimmedLine.startsWith('http') && currentChannel) {
          currentChannel.url = trimmedLine;
          channels.push(currentChannel);
          currentChannel = null;
        }
      }

      const sampleSize = Math.min(5, channels.length);
      const sampleChannels = channels.slice(0, sampleSize);
      const channelStatuses = await Promise.all(
        sampleChannels.map(async channel => {
          try {
            const headResponse = await axios.head(channel.url, { timeout });
            return headResponse.status === 200;
          } catch {
            return false;
          }
        })
      );

      logAction('check_m3u_success', { url, channels: channels.length });
      return {
        type: 'M3U/M3U8',
        status: channelStatuses.some(status => status) ? 'Activa' : 'Inactiva',
        totalChannels: channels.length,
        server: url.split('/').slice(0, 3).join('/')
      };
    }

    if (url.endsWith('.ts') || url.includes('live') || url.includes('hls')) {
      const response = await axios.head(url, { timeout });
      logAction('check_direct_success', { url });
      return {
        type: 'Enlace Directo',
        status: response.status === 200 ? 'Activa' : 'Inactiva',
        totalChannels: 1,
        server: url.split('/').slice(0, 3).join('/')
      };
    }

    const response = await axios.head(url, { timeout });
    logAction('check_generic_success', { url });
    return {
        type: 'Genérico',
        status: response.status === 200 ? 'Activa' : 'Inactiva',
        totalChannels: 1,
        server: url.split('/').slice(0, 3).join('/')
    };
  } catch (error) {
    const errorMsg = error.response?.status === 404 ? 'Servidor no encontrado (404)' : error.message.includes('timeout') ? 'Tiempo agotado' : 'Error al verificar';
    logAction('check_error', { url, error: errorMsg });
    return { type: 'Desconocido', status: 'Error', error: errorMsg, server: url.split('/').slice(0, 3).join('/') };
  }
}

// Formatear respuesta
function formatResponse(msg, result) {
  const timestamp = new Date().toLocaleString('es-ES', { timeZone: 'America/Mexico_City' });
  const userMention = getUserMention(msg.from);

  let messageText = result.error ? `Error: ${escapeMarkdown(result.error)}` 
    : result.status === 'Activa' ? '✅ Lista activa y funcionando.' 
    : '❌ Lista no activa actualmente.';

  const combo = result.username && result.password 
    ? `${escapeMarkdown(result.username)}:${escapeMarkdown(result.password)}` 
    : 'No disponible';

  const serverReal = result.type === 'Xtream Codes' 
    ? escapeMarkdown(result.server) 
    : escapeMarkdown(result.server);

  const response = `✨ Hola ${userMention}, aquí tienes los detalles de tu lista IPTV ✨\n\n` +
    `📅 *Fecha y hora*: ${timestamp}\n` +
    `📡 *Lista*: ${escapeMarkdown(result.server || 'N/A')}\n` +
    `💬 *Estado*: ${messageText}\n` +
    `🔑 *Combo*: ${combo}\n` +
    `📅 *Creada*: ${result.createdAt || 'No disponible'}\n` +
    `⏰ *Expira*: ${result.expiresAt || 'No disponible'}\n` +
    `🔗 *Conexiones*: ${result.activeConnections !== undefined ? `${result.activeConnections}/${result.maxConnections}` : 'No disponible'}\n` +
    `📺 *Canales*: ${result.totalChannels || 0}\n` +
    `🌐 *Servidor Real*: ${serverReal}\n` +
    `⏲ *Zona horaria*: ${result.timezone || 'No disponible'}\n\n` +
    `🚀 *${botName} - 100% Gratis*${adminMessage}`;

  return { text: response };
}

// Menú principal
const mainMenu = {
  reply_markup: {
    inline_keyboard: [
      [
        { text: '🔎 Verificar Lista', callback_data: 'check' },
        { text: 'ℹ️ Ayuda', callback_data: 'guia' }
      ]
    ]
  }
};

// Manejo de botones
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const threadId = query.message.message_thread_id || '0';
  const userId = query.from.id;
  const messageId = query.message.message_id;
  const userMention = getUserMention(query.from);
  const allowedThreadId = getAllowedThreadId(chatId);

  if (!isAllowedContext(chatId, threadId)) return;

  try {
    await bot.answerCallbackQuery(query.id);

    if (!userStates[userId]) userStates[userId] = {};

    if (query.data === 'check') {
      userStates[userId].action = 'check';
      await bot.editMessageText(`🔎 ${userMention}, envía un enlace IPTV (M3U, Xtream, TS, etc.): 📡${adminMessage}`, {
        chat_id: chatId,
        message_id: messageId,
        message_thread_id: allowedThreadId,
        parse_mode: 'Markdown'
      });
    } else if (query.data === 'guia') {
      await bot.sendMessage(chatId, `/guia`, {
        message_thread_id: allowedThreadId
      });
    }
  } catch (error) {
    logAction('callback_error', { action: query.data, error: error.message });
    if (error.response?.status === 429) {
      const retryAfter = error.response.data.parameters.retry_after || 1;
      await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
      return;
    }
    const message = await bot.sendMessage(chatId, `❌ ${userMention}, error: ${error.message}${adminMessage}`, {
      message_thread_id: allowedThreadId,
      parse_mode: 'Markdown'
    });
    autoDeleteMessage(chatId, message.message_id, allowedThreadId);
  }
});

// Comando /iptv
bot.onText(/\/iptv/, async (msg) => {
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id || '0';
  const userMention = getUserMention(msg.from);
  const allowedThreadId = getAllowedThreadId(chatId);

  if (!isAllowedContext(chatId, threadId)) return;

  const response = `🌟 ¡Hola ${userMention}! Bienvenido a *${botName}* 🌟\n\n` +
    `Verifica tus listas IPTV gratis y rápido. Usa los botones o envía un enlace.\n` +
    `Explora con /guia para más info.${adminMessage}`;
  const message = await bot.sendMessage(chatId, response, {
    parse_mode: 'Markdown',
    message_thread_id: allowedThreadId,
    ...mainMenu
  });

  autoDeleteMessage(chatId, message.message_id, allowedThreadId);
});

// Comando /guia
bot.onText(/\/guia/, async (msg) => {
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id || '0';
  const userMention = getUserMention(msg.from);
  const allowedThreadId = getAllowedThreadId(chatId);

  if (!isAllowedContext(chatId, threadId)) return;

  const helpMessage = `📖 *Guía de ${botName}* para ${userMention} 📖\n\n` +
    `✨ *¿Qué soy?*\n` +
    `Un bot gratuito exclusivo para EntresHijos, que verifica listas IPTV rápido y fácil.\n\n` +
    `🔧 *¿Cómo usarme?*\n` +
    `- Pulsa "Verificar Lista" o envía un enlace directamente.\n` +
    `- Obtén un informe detallado al instante.\n` +
    `- Mensajes se borran tras 5 min.\n\n` +
    `📋 *Formatos compatibles*:\n` +
    `- *Xtream*: http://server.com/get.php?username=xxx&password=yyy\n` +
    `- *M3U/M3U8*: http://server.com/playlist.m3u\n` +
    `- *TS/HLS*: http://server.com/stream.ts\n` +
    `- *Otros*: Si es URL, lo intento.\n\n` +
    `💡 *Pasos*:\n` +
    `1. Usa "Verificar Lista" o envía tu enlace.\n` +
    `2. ¡Listo! Respuesta profesional al momento.\n\n` +
    `🚀 *Gratis y Entre 😉 fácil*${adminMessage}`;

  const message = await bot.sendMessage(chatId, helpMessage, {
    parse_mode: 'Markdown',
    message_thread_id: allowedThreadId,
    ...mainMenu
  });

  autoDeleteMessage(chatId, message.message_id, allowedThreadId);
});

// Procesar URLs IPTV
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id || '0';
  const userId = msg.from.id;
  const text = msg.text || '';
  const userMention = getUserMention(msg.from);
  const allowedThreadId = getAllowedThreadId(chatId);

  if (!isAllowedContext(chatId, threadId)) return;

  if (!userStates[userId]) userStates[userId] = {};

  const isIPTV = text.match(/(http|https):\/\/[^\s]+/) || text.includes('get.php') || text.includes('.m3u') || text.includes('.m3u8') || text.includes('.ts') || text.includes('hls');

  if ((userStates[userId].action === 'check' || !userStates[userId].action) && isIPTV) {
    const url = text.match(/(http|https):\/\/[^\s]+/)?.[0] || text;

    const checkingMessage = await bot.sendMessage(chatId, `🔎 ${userMention}, verificando ${escapeMarkdown(url)}...${adminMessage}`, {
      parse_mode: 'Markdown',
      message_thread_id: allowedThreadId
    });
    autoDeleteMessage(chatId, checkingMessage.message_id, allowedThreadId);

    await showLoadingAnimation(chatId, allowedThreadId, checkingMessage.message_id, `🔎 ${userMention}, verificando ${escapeMarkdown(url)}...`);

    const result = await checkIPTVList(url, userId);

    if (!userHistory[userId]) userHistory[userId] = [];
    userHistory[userId].push({ url, result, timestamp: new Date() });

    const { text: responseText } = formatResponse(msg, result);

    await bot.editMessageText(responseText, {
      chat_id: chatId,
      message_id: checkingMessage.message_id,
      message_thread_id: allowedThreadId,
      parse_mode: 'Markdown',
      ...mainMenu
    });

    userStates[userId].action = null;
  }
});

// Manejo de errores global
bot.on('polling_error', (error) => logAction('polling_error', { error: error.message }));
bot.on('webhook_error', (error) => logAction('webhook_error', { error: error.message }));

console.log(`🚀 ${botName} iniciado correctamente`);

// Mantener servidor activo (para UptimeRobot)
setInterval(() => {
  axios.get('https://entrelinks.onrender.com')
    .then(() => logAction('keep_alive', { status: 'success' }))
    .catch(error => logAction('keep_alive_error', { error: error.message }));
}, 5 * 60 * 1000); // Cada 5 minutos, compatible con UptimeRobot

module.exports = bot;