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

// Webhook
const webhookUrl = 'https://entrelinks.onrender.com';

// IDs permitidos
const ALLOWED_CHAT_IDS = [
  { chatId: '-1002348662107', threadId: '53411', name: 'EntresHijos' },
  { chatId: '-1002565012502', threadId: null, name: 'BotChecker_IPTV_ParaG' }
];

// Almacenar datos
let userHistory = {};
let commandHistory = {};
let userStates = {}; // Estado de cada usuario para manejar interacciones
let userConfigs = {}; // Configuraciones por usuario (timeout)

// Mensaje fijo
const adminMessage = '\n\n👨‍💼 *Equipo de Administración EntresHijos*';

// Registrar logs (solo en consola)
function logAction(action, details) {
  const timestamp = new Date().toLocaleString('es-ES');
  console.log(`[${timestamp}] ${action}:`, details);
}

// Escapar caracteres especiales para Markdown
function escapeMarkdown(text) {
  return text.replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

// Obtener el nombre de usuario con @ o el nombre
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
  }, 300000); // 5 minutos = 300,000 ms
}

// Animación de "cargando" con emojis
async function showLoadingAnimation(chatId, threadId, messageId, baseText, duration) {
  const frames = ['🔍', '⏳', '🔎'];
  let frameIndex = 0;
  const interval = 1000; // 1 segundo por frame
  const steps = Math.floor(duration / interval);

  for (let i = 0; i < steps; i++) {
    const frame = frames[frameIndex % frames.length];
    try {
      await bot.editMessageText(`${baseText} ${frame}`, {
        chat_id: chatId,
        message_id: messageId,
        message_thread_id: threadId,
        parse_mode: 'Markdown'
      });
    } catch (error) {
      if (error.response?.status === 429) {
        const retryAfter = error.response.data.parameters.retry_after || 1;
        logAction('rate_limit_error', { retryAfter });
        await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
        continue;
      }
      logAction('loading_animation_error', { chatId, messageId, error: error.message });
      break;
    }
    frameIndex++;
    await new Promise(resolve => setTimeout(resolve, interval));
  }
}

// Ruta webhook
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

// Configurar webhook con reintentos para manejar 429
async function setWebhookWithRetry() {
  try {
    await bot.setWebHook(`${webhookUrl}/bot${token}`);
    logAction('webhook_set', { url: `${webhookUrl}/bot${token}` });
  } catch (error) {
    logAction('webhook_error', { error: error.message, status: error.response?.status });
    if (error.response?.status === 429) {
      const retryAfter = error.response.data.parameters.retry_after || 1;
      console.warn(`⚠️ Error 429. Reintentando en ${retryAfter}s...`);
      await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
      return setWebhookWithRetry();
    }
    throw error;
  }
}

// Verificar contexto
function isAllowedContext(chatId, threadId) {
  const group = ALLOWED_CHAT_IDS.find(g => g.chatId === String(chatId));
  if (!group) return false;
  return group.threadId ? String(threadId) === group.threadId : true;
}

// Verificar lista IPTV
async function checkIPTVList(url, userId) {
  logAction('check_start', { url });
  try {
    url = url.trim();
    if (!url.startsWith('http')) url = `http://${url}`;

    const timeout = userConfigs[userId]?.timeout || 3000;

    // 1. Xtream Codes
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

    // 2. M3U/M3U8
    if (url.endsWith('.m3u') || url.endsWith('.m3u8')) {
      const response = await axios.get(url, { timeout });
      const lines = response.data.split('\n');
      const channels = [];
      let currentChannel = null;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('#EXTINF')) {
          const name = line.split(',')[1]?.trim() || 'Canal sin nombre';
          currentChannel = { name, url: null };
        } else if (line.startsWith('http') && currentChannel) {
          currentChannel.url = line;
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
          } catch (error) {
            return false;
          }
        })
      );

      logAction('check_m3u_success', { url, channels: channels.length });
      return {
        type: 'M3U/M3U8',
        status: channelStatuses.some(status => status) ? 'Activa' : 'Inactiva',
        totalChannels: channels.length,
        server: url
      };
    }

    // 3. Enlace directo (TS, HLS, etc.)
    if (url.endsWith('.ts') || url.includes('live') || url.includes('hls')) {
      const response = await axios.head(url, { timeout });
      logAction('check_direct_success', { url });
      return {
        type: 'Enlace Directo',
        status: response.status === 200 ? 'Activa' : 'Inactiva',
        totalChannels: 1,
        server: url
      };
    }

    // 4. Otros formatos (intento genérico)
    const response = await axios.head(url, { timeout });
    logAction('check_generic_success', { url });
    return {
      type: 'Genérico',
      status: response.status === 200 ? 'Activa' : 'Inactiva',
      totalChannels: 1,
      server: url
    };
  } catch (error) {
    const errorMsg = error.response?.status === 404 ? 'Servidor no encontrado (404)' : error.message.includes('timeout') ? 'Tiempo agotado' : error.message;
    logAction('check_error', { url, error: errorMsg });
    return { type: 'Desconocido', status: 'Error', error: errorMsg, server: url };
  }
}

// Formatear respuesta profesional
function formatResponse(msg, result) {
  const timestamp = new Date().toLocaleString('es-ES', { timeZone: 'America/Mexico_City' });
  const userMention = getUserMention(msg.from);

  let messageText = '';
  if (result.error) {
    messageText = `Error: ${escapeMarkdown(result.error)}`;
  } else if (result.status === 'Activa') {
    messageText = 'La lista está funcionando correctamente.';
  } else {
    messageText = 'La lista no está activa en este momento.';
  }

  const combo = result.username && result.password 
    ? `${escapeMarkdown(result.username)}:${escapeMarkdown(result.password)}` 
    : 'No disponible';

  const response = `✨ Hola ${userMention}, esta es la información de tu lista gracias a *${botName}* ✨\n\n` +
    `📅-🕒 *Día y hora de comprobación*: ${timestamp}\n` +
    `📡 *Lista M3U*: ${escapeMarkdown(result.server || 'N/A')}\n` +
    `💬 *Mensaje*: ${messageText}\n` +
    `📊 *Estado*: ${result.status === 'Activa' ? '✅ Activa' : '❌ Inactiva'}\n` +
    `🔑 *Combo*: ${combo}\n` +
    `📅 *Fecha de Creación*: ${result.createdAt || 'No disponible'}\n` +
    `⏰ *Fecha de Caducidad*: ${result.expiresAt || 'No disponible'}\n` +
    `🔗 *Conexiones activas*: ${result.activeConnections !== undefined ? result.activeConnections : 'No disponible'}\n` +
    `🔗 *Conexiones máximas*: ${result.maxConnections !== undefined ? result.maxConnections : 'No disponible'}\n` +
    `📺 *Total de Contenido*: ${result.totalChannels || 0}\n` +
    `🌐 *Servidor Real*: ${result.type === 'Xtream Codes' ? escapeMarkdown(`${result.server}/player_api.php?username=${result.username}&password=${result.password}`) : escapeMarkdown(result.server || 'N/A')}\n` +
    `⏲ *TimeZone*: ${result.timezone || 'No disponible'}\n\n` +
    `🚀 *Potenciado por ${botName} - 100% Gratis*${adminMessage}`;

  return { text: response };
}

// Menú principal
const mainMenu = {
  reply_markup: {
    inline_keyboard: [
      [
        { text: '🔎 Verificar Lista', callback_data: 'check' },
        { text: 'ℹ️ Ayuda', callback_data: 'help' }
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

  const action = query.data;

  try {
    await bot.answerCallbackQuery(query.id);
  } catch (error) {
    logAction('answer_callback_error', { queryId: query.id, error: error.message });
  }

  if (!isAllowedContext(chatId, threadId)) return;

  if (!userStates[userId]) userStates[userId] = {};

  try {
    if (action === 'check') {
      userStates[userId].action = 'check';
      const response = `🔎 ${userMention}, envía un enlace IPTV para verificar (M3U, Xtream, TS, etc.): 📡${adminMessage}`;
      await bot.editMessageText(response, {
        chat_id: chatId,
        message_id: messageId,
        message_thread_id: threadId,
        parse_mode: 'Markdown'
      });
    } else if (action === 'help') {
      const response = `ℹ️ ${userMention}, aquí tienes la ayuda de *${botName}* ℹ️\n\n` +
        `Soy un bot gratuito para verificar listas IPTV. Usa el botón "Verificar Lista" o envía un enlace directamente.\n` +
        `Para más detalles, usa el comando /guia. 📖${adminMessage}`;
      await bot.editMessageText(response, {
        chat_id: chatId,
        message_id: messageId,
        message_thread_id: threadId,
        parse_mode: 'Markdown',
        ...mainMenu
      });
    }
  } catch (error) {
    if (error.response?.status === 429) {
      const retryAfter = error.response.data.parameters.retry_after || 1;
      logAction('rate_limit_error', { retryAfter });
      await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
      return;
    }
    logAction('callback_error', { action, error: error.message });
    const message = await bot.sendMessage(chatId, `❌ ${userMention}, ocurrió un error: ${error.message} ⚠️${adminMessage}`, {
      message_thread_id: threadId,
      parse_mode: 'Markdown'
    });
    autoDeleteMessage(chatId, message.message_id, threadId);
  }
});

// Comando /iptv
bot.onText(/\/iptv/, async (msg) => {
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id || '0';
  const userMention = getUserMention(msg.from);

  if (!isAllowedContext(chatId, threadId)) return;

  const response = `🌟 ¡Bienvenido ${userMention} a *${botName}*! 🌟\n\n` +
    `Soy un bot gratuito para verificar y gestionar listas IPTV. Usa los botones o envía un enlace directamente.\n\n` +
    `Dispones del comando /guia para saber cómo funciona.${adminMessage}`;
  const message = await bot.sendMessage(chatId, response, {
    parse_mode: 'Markdown',
    message_thread_id: threadId,
    ...mainMenu
  });

  autoDeleteMessage(chatId, message.message_id, threadId);
});

// Comando /guia
bot.onText(/\/guia/, async (msg) => {
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id || '0';
  const userMention = getUserMention(msg.from);

  if (!isAllowedContext(chatId, threadId)) return;

  const helpMessage = `📖 *Guía de ${botName}* para ${userMention} 📖\n\n` +
    `✨ *¿Qué hace este bot?*\n` +
    `Soy un bot gratuito de uso exclusivo de miembros de los grupos EntresHijos, que te ayuda a verificar multiples y formatos de listas IPTV de manera rápida y sencilla. Puedo analizar si tu lista está activa y darte información detallada.\n\n` +
    `🔧 *¿Cómo usarlo?*\n` + +
    `- Haz clic en "Verificar Lista" y envía un enlace (o envíalo directamente).\n` +
    `- Recibirás un informe con el estado de tu lista.\n` +
    `- Todos los mensajes se eliminan automáticamente tras 5 minutos para mantener el chat limpio.\n\n` +
    `📋 *Listas que puedo verificar*:\n` +
    `- *Xtream Codes*: Ejemplo: http://server.com/get.php?username=xxx&password=yyy\n` +
    `- *M3U/M3U8*: Ejemplo: http://server.com/playlist.m3u\n` +
    `- *Enlaces directos (TS/HLS)*: Ejemplo: http://server.com/stream.ts\n` +
    `- *Otros formatos*: Si es una URL, intentaré verificarla.\n\n` +
    `💡 *Pasos simples*:\n` + +
    `1. Usa el botón "Verificar Lista" o envía tu enlace.\n` +
    `2. ¡Listo! Obtendrás un informe claro y profesional.\n\n` +
    `🚀 *100% gratis y Entre 😉 fácil de usar*. ¡Pruébame!${adminMessage}`;

  const message = await bot.sendMessage(chatId, helpMessage, {
    parse_mode: 'Markdown',
    message_thread_id: threadId,
    ...mainMenu
  });

  autoDeleteMessage(chatId, message.message_id, threadId);
});

// Procesar mensajes con URLs IPTV
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id || '0';
  const userId = msg.from.id;
  const text = msg.text || '';
  const userMention = getUserMention(msg.from);

  if (!isAllowedContext(chatId, threadId)) return;

  if (!userStates[userId]) userStates[userId] = {};

  const isIPTV = text.match(/(http|https):\/\/[^\s]+/) || text.includes('get.php') || text.includes('.m3u') || text.includes('.m3u8') || text.includes('.ts') || text.includes('hls');

  if ((userStates[userId].action === 'check' || !userStates[userId].action) && isIPTV) {
    const url = text.match(/(http|https):\/\/[^\s]+/)?.[0] || text;

    const checkingMessage = await bot.sendMessage(chatId, `🔎 ${userMention}, verificando la lista ${escapeMarkdown(url)}... 📡${adminMessage}`, {
      parse_mode: 'Markdown',
      message_thread_id: threadId
    });
    autoDeleteMessage(chatId, checkingMessage.message_id, threadId);

    await showLoadingAnimation(chatId, threadId, checkingMessage.message_id, `🔎 ${userMention}, verificando la lista ${escapeMarkdown(url)}...`, 2000);

    const result = await checkIPTVList(url, userId);

    if (!userHistory[userId]) userHistory[userId] = [];
    userHistory[userId].push({ url, result, timestamp: new Date() });

    const { text: responseText } = formatResponse(msg, result);

    await bot.editMessageText(responseText, {
      chat_id: chatId,
      message_id: checkingMessage.message_id,
      message_thread_id: threadId,
      parse_mode: 'Markdown',
      ...mainMenu
    });

    userStates[userId].action = null;
  }
});

// Manejo de errores global
bot.on('polling_error', (error) => {
  logAction('polling_error', { error: error.message });
});

bot.on('webhook_error', (error) => {
  logAction('webhook_error', { error: error.message });
});

console.log(`🚀 ${botName} iniciado correctamente`);

// Mantener el servidor activo (para Render)
setInterval(() => {
  axios.get('https://entrelinks.onrender.com')
    .then(() => logAction('keep_alive', { status: 'success' }))
    .catch(error => logAction('keep_alive_error', { error: error.message }));
}, 5 * 60 * 1000); // Cada 5 minutos

module.exports = bot;