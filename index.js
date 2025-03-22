const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const cron = require('node-cron');
const axios = require('axios');

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
let userFavorites = {};
let processedUpdates = new Set(); // Para evitar procesar actualizaciones duplicadas

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

// Animación de carga
async function showLoadingAnimation(chatId, threadId, messageId, baseText) {
  const frames = ['🔍', '⏳', '🔎'];
  let frameIndex = 0;
  const duration = 1000;
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
  const updateId = req.body.update_id;
  if (processedUpdates.has(updateId)) {
    res.sendStatus(200);
    return;
  }
  processedUpdates.add(updateId);
  if (processedUpdates.size > 1000) {
    processedUpdates.clear(); // Limpiar para evitar crecimiento infinito
  }
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

// Añadir puerto predeterminado si falta
function ensurePort(url) {
  if (!url.startsWith('http')) url = `http://${url}`;
  const urlObj = new URL(url);
  if (!urlObj.port) urlObj.port = urlObj.protocol === 'https:' ? '443' : '80';
  return urlObj.toString();
}

// Validar formato de enlace IPTV
function isValidIPTVFormat(url) {
  return url.includes('get.php') || url.endsWith('.m3u') || url.endsWith('.m3u8') || url.endsWith('.ts') || url.includes('hls') || url.includes('playlist') || url.includes('stream');
}

// Configuración de axios para ignorar errores de SSL
const axiosInstance = axios.create({
  timeout: 15000,
  httpsAgent: new (require('https').Agent)({
    rejectUnauthorized: false
  })
});

// Verificar lista IPTV (soporte ampliado para más formatos)
async function checkIPTVList(url, userId) {
  logAction('check_start', { url });
  try {
    url = ensurePort(url.trim());

    // 1. Soporte para listas Xtream Codes
    if (url.includes('get.php')) {
      const [, params] = url.split('?');
      const queryParams = Object.fromEntries(new URLSearchParams(params));
      const { username, password } = queryParams;
      const server = url.split('/get.php')[0];
      const apiUrl = `${server}/player_api.php?username=${username}&password=${password}`;

      const response = await axiosInstance.get(apiUrl);
      const { user_info, server_info } = response.data;
      const streams = await axiosInstance.get(`${apiUrl}&action=get_live_streams`);

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

    // 2. Soporte para listas M3U/M3U8 (con o sin autenticación)
    if (url.endsWith('.m3u') || url.endsWith('.m3u8') || url.includes('playlist')) {
      let response;
      try {
        response = await axiosInstance.get(url);
      } catch (error) {
        // Intentar con autenticación básica si falla
        if (error.response?.status === 401 || error.response?.status === 403) {
          const urlObj = new URL(url);
          const username = urlObj.username || 'guest';
          const password = urlObj.password || 'guest';
          response = await axiosInstance.get(url, {
            auth: { username, password }
          });
        } else {
          throw error;
        }
      }

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
            const headResponse = await axiosInstance.head(channel.url);
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
        server: url.split('/').slice(0, 3).join('/'),
        expiresAt: 'Desconocida' // M3U no suele incluir fecha de caducidad
      };
    }

    // 3. Soporte para enlaces directos (TS, HLS, etc.)
    if (url.endsWith('.ts') || url.includes('hls') || url.includes('stream')) {
      const response = await axiosInstance.head(url);
      logAction('check_direct_success', { url });
      return {
        type: 'Enlace Directo',
        status: response.status === 200 ? 'Activa' : 'Inactiva',
        totalChannels: 1,
        server: url.split('/').slice(0, 3).join('/'),
        expiresAt: 'Desconocida'
      };
    }

    throw new Error('Formato no soportado');
  } catch (error) {
    let errorMsg;
    if (error.response) {
      if (error.response.status === 403) {
        errorMsg = 'Acceso denegado (403): El servidor rechazó la solicitud, puede estar protegido.';
      } else if (error.response.status === 404) {
        errorMsg = 'No encontrado (404): El enlace no está disponible.';
      } else {
        errorMsg = `Error del servidor (${error.response.status}): ${error.response.statusText}`;
      }
    } else if (error.message.includes('timeout')) {
      errorMsg = 'Tiempo agotado: El servidor no respondió a tiempo.';
    } else if (error.message.includes('EPROTO')) {
      errorMsg = 'Error de conexión SSL: Problema con el certificado del servidor.';
    } else {
      errorMsg = `Error al verificar: ${error.message}`;
    }
    logAction('check_error', { url, error: errorMsg });
    return { type: 'Desconocido', status: 'Error', error: errorMsg, server: url.split('/').slice(0, 3).join('/'), expiresAt: 'Desconocida' };
  }
}

// Formatear respuesta con enlace clickable
function formatResponse(msg, result, originalUrl) {
  const timestamp = new Date().toLocaleString('es-ES', { timeZone: 'America/Mexico_City' });
  const userMention = getUserMention(msg.from);

  let messageText = result.error ? `Error: ${escapeMarkdown(result.error)}` 
    : result.status === 'Activa' ? '✅ Lista activa y funcionando.' 
    : '❌ Lista no activa actualmente.';

  const combo = result.username && result.password 
    ? `${escapeMarkdown(result.username)}:${escapeMarkdown(result.password)}` 
    : 'No disponible';

  const serverReal = result.type === 'Xtream Codes' ? result.server : result.server;

  let serverRealLink = serverReal;
  try {
    serverRealLink = encodeURI(serverReal);
  } catch (e) {
    serverRealLink = serverReal;
  }

  const response = `✨ Hola ${userMention}, aquí tienes los detalles de tu lista IPTV ✨\n\n` +
    `📅 *Fecha y hora*: ${timestamp}\n` +
    `📡 *Lista*: [${escapeMarkdown(originalUrl)}](${originalUrl})\n` +
    `💬 *Estado*: ${messageText}\n` +
    `🔑 *Combo*: ${combo}\n` +
    `📅 *Creada*: ${result.createdAt || 'No disponible'}\n` +
    `⏰ *Expira*: ${result.expiresAt || 'No disponible'}\n` +
    `🔗 *Conexiones*: ${result.activeConnections !== undefined ? `${result.activeConnections}/${result.maxConnections}` : 'No disponible'}\n` +
    `📺 *Canales*: ${result.totalChannels || 0}\n` +
    `🌐 *Servidor Real*: [${escapeMarkdown(serverReal)}](${serverRealLink})\n` +
    `⏲ *Zona horaria*: ${result.timezone || 'Desconocida'}\n\n` +
    `🚀 *${botName} - Verificación Profesional y Gratuita*${adminMessage}`;

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
      await bot.editMessageText(`🔎 ${userMention}, envía un enlace IPTV válido (M3U, Xtream, TS, etc.): 📡${adminMessage}`, {
        chat_id: chatId,
        message_id: messageId,
        message_thread_id: allowedThreadId,
        parse_mode: 'Markdown'
      });
    } else if (query.data === 'guia') {
      const helpMessage = `🌟 *Bienvenido a ${botName}, ${userMention}!* 🌟\n\n` +
        `👋 Somos un bot profesional y gratuito exclusivo para *EntresHijos*, diseñado para gestionar y verificar listas IPTV de forma sencilla y eficiente.\n\n` +
        `📋 *Comandos disponibles*:\n` +
        `- *🔍 /guia*: Muestra esta guía de uso.\n` +
        `- *💾 /save [nombre]*: Guarda la última lista verificada con un nombre.\n` +
        `- *📜 /baul*: Lista todas tus listas guardadas.\n` +
        `- *✅ /registro*: Muestra tus listas activas, ordenadas por fecha de caducidad.\n` +
        `- *🎁 /generar*: Obtiene listas IPTV gratuitas verificadas de múltiples fuentes.\n\n` +
        `🔧 *Cómo usar el bot*:\n` +
        `1️⃣ Usa los botones o envía un enlace IPTV válido.\n` +
        `2️⃣ Recibe un informe detallado al instante.\n\n` +
        `📡 *Formatos compatibles*:\n` +
        `- *Xtream*: \`http://server.com:80/get.php?username=xxx&password=yyy\`\n` +
        `- *M3U/M3U8*: \`http://server.com:80/playlist.m3u\`\n` +
        `- *TS/HLS*: \`http://server.com:80/stream.ts\`\n\n` +
        `🚀 *${botName} - Tu aliado en IPTV*${adminMessage}`;

      await bot.sendMessage(chatId, helpMessage, {
        parse_mode: 'Markdown',
        message_thread_id: allowedThreadId,
        ...mainMenu
      });
    }
  } catch (error) {
    logAction('callback_error', { action: query.data, error: error.message });
    if (error.response?.status === 429) {
      const retryAfter = error.response.data.parameters.retry_after || 1;
      await bot.sendMessage(chatId, `⏳ ${userMention}, espera un momento, demasiadas solicitudes. Reintentando en ${retryAfter} segundos...${adminMessage}`, {
        parse_mode: 'Markdown',
        message_thread_id: allowedThreadId
      });
      await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
      return;
    }
    await bot.sendMessage(chatId, `❌ ${userMention}, error: ${error.message}${adminMessage}`, {
      message_thread_id: allowedThreadId,
      parse_mode: 'Markdown'
    });
  }
});

// Comando /iptv (inicio)
bot.onText(/\/iptv/, async (msg) => {
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id || '0';
  const userMention = getUserMention(msg.from);
  const allowedThreadId = getAllowedThreadId(chatId);

  if (!isAllowedContext(chatId, threadId)) return;

  const response = `🌟 ¡Hola ${userMention}! Bienvenido a *${botName}* 🌟\n\n` +
    `✅ Verifica tus listas IPTV de forma gratuita y rápida.\n` +
    `🔧 Usa los botones o envía un enlace válido directamente.\n` +
    `ℹ️ Pulsa "Ayuda" para aprender a usarme.\n\n` +
    `👨‍💼 *Equipo de Administración EntresHijos*`;
  await bot.sendMessage(chatId, response, {
    parse_mode: 'Markdown',
    message_thread_id: allowedThreadId,
    ...mainMenu
  });
});

// Comando /guia
bot.onText(/\/guia/, async (msg) => {
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id || '0';
  const userMention = getUserMention(msg.from);
  const allowedThreadId = getAllowedThreadId(chatId);

  if (!isAllowedContext(chatId, threadId)) return;

  const helpMessage = `🌟 *Bienvenido a ${botName}, ${userMention}!* 🌟\n\n` +
    `👋 Somos un bot profesional y gratuito exclusivo para *EntresHijos*, diseñado para gestionar y verificar listas IPTV de forma sencilla y eficiente.\n\n` +
    `📋 *Comandos disponibles*:\n` +
    `- *🔍 /guia*: Muestra esta guía de uso.\n` +
    `- *💾 /save [nombre]*: Guarda la última lista verificada con un nombre.\n` +
    `- *📜 /baul*: Lista todas tus listas guardadas.\n` +
    `- *✅ /registro*: Muestra tus listas activas, ordenadas por fecha de caducidad.\n` +
    `- *🎁 /generar*: Obtiene listas IPTV gratuitas verificadas de múltiples fuentes.\n\n` +
    `🔧 *Cómo usar el bot*:\n` +
    `1️⃣ Usa los botones o envía un enlace IPTV válido.\n` +
    `2️⃣ Recibe un informe detallado al instante.\n\n` +
    `📡 *Formatos compatibles*:\n` +
    `- *Xtream*: \`http://server.com:80/get.php?username=xxx&password=yyy\`\n` +
    `- *M3U/M3U8*: \`http://server.com:80/playlist.m3u\`\n` +
    `- *TS/HLS*: \`http://server.com:80/stream.ts\`\n\n` +
    `🚀 *${botName} - Tu aliado en IPTV*${adminMessage}`;

  await bot.sendMessage(chatId, helpMessage, {
    parse_mode: 'Markdown',
    message_thread_id: allowedThreadId,
    ...mainMenu
  });
});

// Comando /menu (exclusivo para grupo de administración)
bot.onText(/\/menu/, async (msg) => {
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id || '0';
  const userMention = getUserMention(msg.from);
  const allowedThreadId = getAllowedThreadId(chatId);

  if (String(chatId) !== '-1002565012502' || !isAllowedContext(chatId, threadId)) return;

  const menuMessage = `🛠 *Menú Completo de ${botName} para ${userMention}* 🛠\n\n` +
    `👋 Bienvenido al panel de comandos completo de *${botName}*. Aquí tienes todas las herramientas disponibles:\n\n` +
    `📋 *Comandos Públicos*:\n` +
    `- *🔍 /guia*: Muestra la guía básica para usuarios.\n` +
    `- *💾 /save [nombre]*: Guarda la última lista verificada con un nombre personalizado.\n` +
    `- *📜 /baul*: Muestra todas las listas guardadas del usuario.\n` +
    `- *✅ /registro*: Lista las listas activas guardadas, ordenadas por fecha de caducidad.\n` +
    `- *🎁 /generar*: Genera y verifica listas IPTV gratuitas de múltiples fuentes.\n\n` +
    `🔒 *Comandos de Administración* (solo aquí):\n` +
    `- *📊 /historial*: Muestra el historial completo de verificaciones de todos los usuarios.\n` +
    `- *🌟 /iptv*: Comando de bienvenida inicial (uso interno).\n\n` +
    `🔧 *Cómo funciona*:\n` +
    `- Envía un enlace IPTV o usa los botones para verificar.\n` +
    `- Usa /save después de verificar para guardar listas.\n` +
    `- Las listas favoritas se verifican automáticamente cada 24 horas.\n\n` +
    `💡 *Nota*: Los comandos de administración son exclusivos de este grupo.\n\n` +
    `🚀 *${botName} - Gestión Avanzada de IPTV*${adminMessage}`;

  await bot.sendMessage(chatId, menuMessage, {
    parse_mode: 'Markdown',
    message_thread_id: allowedThreadId
  });
});

// Comando /historial (solo admin)
bot.onText(/\/historial/, async (msg) => {
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id || '0';
  const userMention = getUserMention(msg.from);
  const allowedThreadId = getAllowedThreadId(chatId);

  if (String(chatId) !== '-1002565012502' || !isAllowedContext(chatId, threadId)) return;

  if (Object.keys(userHistory).length === 0) {
    await bot.sendMessage(chatId, `📜 Hola ${userMention}, aún no hay historial de uso en *${botName}*.${adminMessage}`, {
      parse_mode: 'Markdown',
      message_thread_id: allowedThreadId
    });
    return;
  }

  let totalChecks = 0, activeCount = 0;
  for (const history of Object.values(userHistory)) {
    totalChecks += history.length;
    activeCount += history.filter(entry => entry.result.status === 'Activa').length;
  }

  let historyText = `📜 *Historial de Uso de ${botName}* 📜\n\n` +
                   `📊 *Estadísticas*: ${totalChecks} verificaciones, ${activeCount} activas\n\n`;
  for (const [userId, history] of Object.entries(userHistory)) {
    const user = history[0].url ? await bot.getChatMember(chatId, userId).then(member => member.user) : { username: 'Desconocido', first_name: 'Usuario' };
    const userMention = getUserMention(user);
    historyText += `👤 *Usuario*: ${userMention} (ID: ${userId})\n` +
                   `📊 *Número de usos*: ${history.length}\n` +
                   `📋 *Detalles*:\n`;

    history.forEach((entry, index) => {
      const timestamp = entry.timestamp.toLocaleString('es-ES', { timeZone: 'America/Mexico_City' });
      historyText += `  ${index + 1}. 📅 ${timestamp} - [${escapeMarkdown(entry.url)}](${entry.url})\n`;
    });
    historyText += '\n';
  }
  historyText += `🚀 *${botName} - Verificación Profesional y Gratuita*${adminMessage}`;

  await bot.sendMessage(chatId, historyText, {
    parse_mode: 'Markdown',
    message_thread_id: allowedThreadId
  });
});

// Comando /save
bot.onText(/\/save (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const name = match[1];
  const allowedThreadId = getAllowedThreadId(chatId);
  if (!isAllowedContext(chatId, msg.message_thread_id || '0')) return;

  if (!userHistory[userId] || !userHistory[userId].length) {
    await bot.sendMessage(chatId, `❌ ${getUserMention(msg.from)}, no tienes listas recientes para guardar.${adminMessage}`, {
      parse_mode: 'Markdown',
      message_thread_id: allowedThreadId
    });
    return;
  }

  const lastUrl = userHistory[userId][userHistory[userId].length - 1].url;
  if (!userFavorites[userId]) userFavorites[userId] = {};
  userFavorites[userId][name] = lastUrl;
  await bot.sendMessage(chatId, `💾 Lista "${name}" guardada: ${lastUrl}${adminMessage}`, {
    parse_mode: 'Markdown',
    message_thread_id: allowedThreadId
  });
});

// Comando /baul (antes /list)
bot.onText(/\/baul/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const allowedThreadId = getAllowedThreadId(chatId);
  if (!isAllowedContext(chatId, msg.message_thread_id || '0')) return;

  if (!userFavorites[userId] || !Object.keys(userFavorites[userId]).length) {
    await bot.sendMessage(chatId, `📋 ${getUserMention(msg.from)}, no tienes listas guardadas.${adminMessage}`, {
      parse_mode: 'Markdown',
      message_thread_id: allowedThreadId
    });
    return;
  }

  let listText = `📋 Listas guardadas de ${getUserMention(msg.from)}:\n`;
  for (const [name, url] of Object.entries(userFavorites[userId])) {
    listText += `- *${name}*: [${escapeMarkdown(url)}](${url})\n`;
  }
  listText += adminMessage;

  await bot.sendMessage(chatId, listText, {
    parse_mode: 'Markdown',
    message_thread_id: allowedThreadId
  });
});

// Comando /registro (antes /lista)
bot.onText(/\/registro/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const allowedThreadId = getAllowedThreadId(chatId);
  const userMention = getUserMention(msg.from);

  if (!isAllowedContext(chatId, msg.message_thread_id || '0')) return;

  if (!userFavorites[userId] || !Object.keys(userFavorites[userId]).length) {
    await bot.sendMessage(chatId, `📋 ${userMention}, no tienes listas guardadas para mostrar.${adminMessage}`, {
      parse_mode: 'Markdown',
      message_thread_id: allowedThreadId
    });
    return;
  }

  const activeLists = [];
  for (const [name, url] of Object.entries(userFavorites[userId])) {
    const historyEntry = userHistory[userId]?.find(h => h.url === url);
    if (historyEntry && historyEntry.result.status === 'Activa') {
      activeLists.push({
        name,
        url,
        expiresAt: historyEntry.result.expiresAt || 'Ilimitada',
        expiresTimestamp: historyEntry.result.expiresAt === 'Ilimitada' ? Infinity : new Date(historyEntry.result.expiresAt).getTime()
      });
    }
  }

  if (activeLists.length === 0) {
    await bot.sendMessage(chatId, `📋 ${userMention}, no tienes listas activas guardadas.${adminMessage}`, {
      parse_mode: 'Markdown',
      message_thread_id: allowedThreadId
    });
    return;
  }

  activeLists.sort((a, b) => b.expiresTimestamp - a.expiresTimestamp);

  let listText = `📋 Listas activas de ${userMention} (ordenadas por caducidad):\n`;
  activeLists.forEach(list => {
    listText += `- *${list.name}*: [${escapeMarkdown(list.url)}](${list.url}) - Expira: ${list.expiresAt}\n`;
  });
  listText += adminMessage;

  await bot.sendMessage(chatId, listText, {
    parse_mode: 'Markdown',
    message_thread_id: allowedThreadId
  });
});

// Comando /generar (generar listas IPTV de múltiples fuentes)
bot.onText(/\/generar/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const allowedThreadId = getAllowedThreadId(chatId);
  const userMention = getUserMention(msg.from);
  if (!isAllowedContext(chatId, msg.message_thread_id || '0')) return;

  const loadingMessage = await bot.sendMessage(chatId, `⏳ ${userMention}, buscando listas IPTV de múltiples fuentes...${adminMessage}`, {
    parse_mode: 'Markdown',
    message_thread_id: allowedThreadId
  });

  try {
    // Fuentes ampliadas para listas IPTV (incluye repositorios públicos y posibles fuentes premium)
    const sources = [
      // Repositorios de GitHub (listas públicas)
      { url: 'https://iptv-org.github.io/iptv/countries/es.m3u', category: 'España' },
      { url: 'https://iptv-org.github.io/iptv/languages/spa.m3u', category: 'Español' },
      { url: 'https://raw.githubusercontent.com/iptv-org/iptv/master/streams/es.m3u', category: 'España' },
      { url: 'https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8', category: 'General' },
      { url: 'https://raw.githubusercontent.com/iptv-restream/iptv-channels/master/channels/es.m3u', category: 'España' },
      { url: 'https://raw.githubusercontent.com/LaSaleta/tv/main/lista.m3u', category: 'España' },
      { url: 'https://raw.githubusercontent.com/iptv-org/iptv/master/streams/mx.m3u', category: 'México' },
      { url: 'https://raw.githubusercontent.com/iptv-org/iptv/master/streams/ar.m3u', category: 'Argentina' },
      { url: 'https://raw.githubusercontent.com/iptv-org/iptv/master/streams/us.m3u', category: 'USA' },
      { url: 'https://raw.githubusercontent.com/iptv-org/iptv/master/streams/uk.m3u', category: 'UK' },
      { url: 'https://raw.githubusercontent.com/iptv-org/iptv/master/streams/sports.m3u', category: 'Deportes' },
      { url: 'https://raw.githubusercontent.com/iptv-org/iptv/master/streams/movies.m3u', category: 'Películas' },
      { url: 'https://raw.githubusercontent.com/iptv-org/iptv/master/streams/music.m3u', category: 'Música' },

      // Fuentes adicionales (públicas)
      { url: 'https://www.tdtchannels.com/lists/tv.m3u8', category: 'España (TDT)' },
      { url: 'https://iptvcat.net/static/uploads/iptv_list_66ebeb47eecf0.m3u', category: 'General' },
      { url: 'https://m3u.cl/lista.m3u', category: 'General' },
      { url: 'https://iptv-org.github.io/iptv/categories/news.m3u', category: 'Noticias' },
      { url: 'https://iptv-org.github.io/iptv/categories/kids.m3u', category: 'Infantil' },
      { url: 'https://iptv-org.github.io/iptv/categories/adult.m3u', category: 'Adultos' },

      // Fuentes de listas premium (públicas, si están disponibles)
      { url: 'https://raw.githubusercontent.com/iptv-org/iptv/master/streams/premium.m3u', category: 'Premium (si disponible)' },
      { url: 'https://iptv-org.github.io/iptv/categories/premium.m3u', category: 'Premium (si disponible)' }
    ];

    const lists = [];
    const errors = [];

    for (const source of sources) {
      try {
        const response = await axiosInstance.get(source.url, { timeout: 15000 });
        if (response.status === 200) {
          lists.push({ url: source.url, type: source.url.endsWith('.m3u8') ? 'M3U8' : 'M3U', category: source.category });
        }
      } catch (error) {
        errors.push(`- ${source.url} (${source.category}): ${error.message}`);
      }
    }

    if (lists.length === 0) {
      const errorText = `❌ ${userMention}, no se encontraron listas confiables en este momento.\n\n` +
                        `*Errores encontrados*:\n${errors.join('\n')}${adminMessage}`;
      await bot.editMessageText(errorText, {
        chat_id: chatId,
        message_id: loadingMessage.message_id,
        message_thread_id: allowedThreadId,
        parse_mode: 'Markdown'
      });
      return;
    }

    let responseText = `🎉 ${userMention}, aquí tienes las listas IPTV más recientes:\n\n`;
    for (const list of lists) {
      const result = await checkIPTVList(list.url, userId);
      responseText += `- *${list.type} (${list.category})*: [${escapeMarkdown(list.url)}](${list.url})\n` +
                      `  - Estado: ${result.status}\n` +
                      `  - Canales: ${result.totalChannels || 'Desconocido'}\n` +
                      `  - Expira: ${result.expiresAt || 'Desconocida'}\n`;

      if (!userHistory[userId]) userHistory[userId] = [];
      userHistory[userId].push({ url: list.url, result, timestamp: new Date() });
      if (userHistory[userId].length > 50) userHistory[userId].shift();
    }
    responseText += `\n💡 Usa /save [nombre] para guardar una lista.\n${adminMessage}`;

    await bot.editMessageText(responseText, {
      chat_id: chatId,
      message_id: loadingMessage.message_id,
      message_thread_id: allowedThreadId,
      parse_mode: 'Markdown'
    });
  } catch (error) {
    logAction('generate_error', { error: error.message });
    await bot.editMessageText(`❌ ${userMention}, error al generar listas: ${error.message}${adminMessage}`, {
      chat_id: chatId,
      message_id: loadingMessage.message_id,
      message_thread_id: allowedThreadId,
      parse_mode: 'Markdown'
    });
  }
});

// Procesar URLs IPTV (solo si no es un comando)
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id || '0';
  const userId = msg.from.id;
  const text = msg.text || '';
  const userMention = getUserMention(msg.from);
  const allowedThreadId = getAllowedThreadId(chatId);

  if (!isAllowedContext(chatId, threadId)) return;

  if (!userStates[userId]) userStates[userId] = {};

  // Ignorar mensajes que sean comandos
  if (text.startsWith('/')) return;

  const urlMatch = text.match(/(http|https):\/\/[^\s]+/);
  if ((userStates[userId].action === 'check' || !userStates[userId].action) && urlMatch) {
    const url = urlMatch[0];

    if (!isValidIPTVFormat(url)) {
      const invalidMessage = `📢 Hola ${userMention}, el formato del enlace no es válido 📢\n\n` +
        `❌ El enlace proporcionado no corresponde a una lista IPTV soportada.\n` +
        `✅ *Formatos aceptados*:\n` +
        `- *Xtream*: \`http://server.com:80/get.php?username=xxx&password=yyy\`\n` +
        `- *M3U/M3U8*: \`http://server.com:80/playlist.m3u\`\n` +
        `- *TS/HLS*: \`http://server.com:80/stream.ts\`\n\n` +
        `🔧 Por favor, envía un enlace en uno de estos formatos.\n` +
        `🚀 *${botName} - Verificación Profesional*${adminMessage}`;
      await bot.sendMessage(chatId, invalidMessage, {
        parse_mode: 'Markdown',
        message_thread_id: allowedThreadId,
        ...mainMenu
      });
      return;
    }

    const checkingMessage = await bot.sendMessage(chatId, `🔎 ${userMention}, verificando ${escapeMarkdown(url)}...${adminMessage}`, {
      parse_mode: 'Markdown',
      message_thread_id: allowedThreadId
    });

    await showLoadingAnimation(chatId, allowedThreadId, checkingMessage.message_id, `🔎 ${userMention}, verificando ${escapeMarkdown(url)}...`);

    const result = await checkIPTVList(url, userId);

    if (!userHistory[userId]) userHistory[userId] = [];
    userHistory[userId].push({ url, result, timestamp: new Date() });
    if (userHistory[userId].length > 50) userHistory[userId].shift();

    const { text: responseText } = formatResponse(msg, result, url);

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

// Verificación programada de listas favoritas (cada 24 horas a medianoche)
cron.schedule('0 0 * * *', async () => {
  for (const [userId, favorites] of Object.entries(userFavorites)) {
    for (const [name, url] of Object.entries(favorites)) {
      const lastResult = userHistory[userId]?.find(h => h.url === url)?.result.status;
      const result = await checkIPTVList(url, userId);
      if (lastResult && result.status !== lastResult) {
        const chatId = ALLOWED_CHAT_IDS[0].chatId;
        const allowedThreadId = getAllowedThreadId(chatId);
        await bot.sendMessage(chatId, `📢 La lista "${name}" de ${userId} cambió a *${result.status}*!${adminMessage}`, {
          parse_mode: 'Markdown',
          message_thread_id: allowedThreadId
        });
      }
      if (!userHistory[userId]) userHistory[userId] = [];
      userHistory[userId].push({ url, result, timestamp: new Date() });
      if (userHistory[userId].length > 50) userHistory[userId].shift();
    }
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
}, 5 * 60 * 1000);

module.exports = bot;