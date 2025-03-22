const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const cron = require('node-cron');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const xml2js = require('xml2js');

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

// Configuración de Supabase
const supabaseUrl = 'https://jxpdivtccnhsspvwfpdl.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp4cGRpdnRjY25oc3NwdndmcGRsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDI2NDc1MzYsImV4cCI6MjA1ODIyMzUzNn0.oVV31TUxJeCEZZByLb5gsvl9vpme8XZ9XnOKoaZFJKI'; // Reemplaza con tu clave anónima de Supabase
const supabase = createClient(supabaseUrl, supabaseKey);

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
let publicLists = []; // Lista temporal para evitar repeticiones

// Mensaje fijo
const adminMessage = '\n\n👨‍💼 *Equipo de Administración EntresHijos*';

// Animaciones para cada tipo de lista
const animations = {
  country: ['🌍', '🌎', '🌏'],
  language: ['📖', '✍️', '📚'],
  category: ['🔍', '🔎', '🕵️'],
  general: ['📺', '📡', '🎥'],
  iptvcat: ['🐾', '🐱', '😺'],
  tdt: ['📻', '📺', '📡'],
  sports: ['⚽', '🏀', '🏈'],
  movies: ['🎬', '🍿', '🎥'],
  music: ['🎵', '🎶', '🎸'],
  premium: ['💎', '🌟', '✨']
};

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

// Animación de carga genérica
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

// Animación específica para cada tipo de lista
async function showListAnimation(chatId, threadId, messageId, baseText, listType) {
  const animationFrames = animations[listType] || ['⏳', '⌛', '⏳'];
  let frameIndex = 0;
  const duration = 2000; // Duración de la animación (2 segundos)
  const interval = 500; // Intervalo entre frames (0.5 segundos)
  const steps = Math.floor(duration / interval);

  for (let i = 0; i < steps; i++) {
    const frame = animationFrames[frameIndex % animationFrames.length];
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

// Configuración de axios para ignorar errores de SSL
const axiosInstance = axios.create({
  timeout: 15000,
  httpsAgent: new (require('https').Agent)({
    rejectUnauthorized: false
  })
});

// Inicializar Supabase y crear tablas si no existen
async function initializeSupabase() {
  try {
    // Crear tabla public_lists
    await supabase
      .from('public_lists')
      .select('*')
      .limit(1)
      .then(async () => {
        logAction('supabase_table_check', { table: 'public_lists', status: 'exists' });
      })
      .catch(async () => {
        await supabase.rpc('execute', {
          query: `
            CREATE TABLE public_lists (
              id SERIAL PRIMARY KEY,
              url TEXT NOT NULL,
              type TEXT NOT NULL,
              category TEXT NOT NULL,
              status TEXT NOT NULL,
              total_channels INTEGER,
              expires_at TEXT,
              last_checked TIMESTAMP DEFAULT NOW()
            );
          `
        });
        logAction('supabase_table_created', { table: 'public_lists' });
      });

    // Crear tabla votes
    await supabase
      .from('votes')
      .select('*')
      .limit(1)
      .then(async () => {
        logAction('supabase_table_check', { table: 'votes', status: 'exists' });
      })
      .catch(async () => {
        await supabase.rpc('execute', {
          query: `
            CREATE TABLE votes (
              id SERIAL PRIMARY KEY,
              list_id INTEGER REFERENCES public_lists(id),
              user_id TEXT NOT NULL,
              vote_type TEXT NOT NULL, -- 'upvote' o 'downvote'
              created_at TIMESTAMP DEFAULT NOW()
            );
          `
        });
        logAction('supabase_table_created', { table: 'votes' });
      });
  } catch (error) {
    logAction('supabase_init_error', { error: error.message });
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
  await initializeSupabase();
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
  return (
    url.includes('get.php') ||
    url.endsWith('.m3u') ||
    url.endsWith('.m3u8') ||
    url.endsWith('.ts') ||
    url.includes('hls') ||
    url.includes('playlist') ||
    url.includes('stream') ||
    url.endsWith('.json') ||
    url.endsWith('.xml')
  );
}

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
        expiresAt: 'Desconocida'
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

    // 4. Soporte para listas JSON
    if (url.endsWith('.json')) {
      const response = await axiosInstance.get(url);
      const data = response.data;

      let channels = [];
      if (Array.isArray(data)) {
        channels = data.map(item => ({
          name: item.name || item.title || 'Canal sin nombre',
          url: item.url || item.stream_url
        }));
      } else if (data.channels) {
        channels = data.channels.map(item => ({
          name: item.name || item.title || 'Canal sin nombre',
          url: item.url || item.stream_url
        }));
      }

      if (!channels.length) throw new Error('No se encontraron canales en el JSON');

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

      logAction('check_json_success', { url, channels: channels.length });
      return {
        type: 'JSON',
        status: channelStatuses.some(status => status) ? 'Activa' : 'Inactiva',
        totalChannels: channels.length,
        server: url.split('/').slice(0, 3).join('/'),
        expiresAt: 'Desconocida'
      };
    }

    // 5. Soporte para listas XML (usando xml2js)
    if (url.endsWith('.xml')) {
      const response = await axiosInstance.get(url);
      const xmlData = response.data;

      const parser = new xml2js.Parser({ explicitArray: false });
      const result = await parser.parseStringPromise(xmlData);

      let channels = [];
      if (result?.channels?.channel) {
        const channelList = Array.isArray(result.channels.channel) ? result.channels.channel : [result.channels.channel];
        channels = channelList.map(item => ({
          name: item.name || item.title || 'Canal sin nombre',
          url: item.url || item.stream_url
        }));
      }

      if (!channels.length) throw new Error('No se encontraron canales en el XML');

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

      logAction('check_xml_success', { url, channels: channels.length });
      return {
        type: 'XML',
        status: channelStatuses.some(status => status) ? 'Activa' : 'Inactiva',
        totalChannels: channels.length,
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

// Manejo de botones (incluye votación)
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
      await bot.editMessageText(`🔎 ${userMention}, envía un enlace IPTV válido (M3U, Xtream, TS, JSON, XML, etc.): 📡${adminMessage}`, {
        chat_id: chatId,
        message_id: messageId,
        message_thread_id: allowedThreadId,
        parse_mode: 'Markdown'
      });
    } else if (query.data === 'guia') {
      const helpMessage = `🌟 *Bienvenido a ${botName}, ${userMention}!* 🌟\n\n` +
        `👋 Somos un bot profesional y gratuito exclusivo para *EntresHijos*, diseñado para gestionar y verificar listas IPTV de forma sencilla y eficiente.\n\n` +
        `📋 *Comandos disponibles*:\n` +
        `- *🔍 /guia* - Muestra esta guía de uso.\n` +
        `- *💾 /save [nombre]* - Guarda la última lista verificada con un nombre.\n` +
        `- *📜 /baul* - Lista todas tus listas guardadas.\n` +
        `- *✅ /registro* - Muestra tus listas activas, ordenadas por fecha de caducidad.\n` +
        `- *🎁 /generar* - Obtiene listas IPTV gratuitas verificadas de múltiples fuentes.\n` +
        `- *📚 /listaspublicas* - Muestra las listas públicas más recientes con votación.\n\n` +
        `🔧 *Cómo usar el bot*:\n` +
        `1️⃣ Usa los botones o envía un enlace IPTV válido.\n` +
        `2️⃣ Recibe un informe detallado al instante.\n\n` +
        `📡 *Formatos compatibles*:\n` +
        `- *Xtream*: \`http://server.com:80/get.php?username=xxx&password=yyy\`\n` +
        `- *M3U/M3U8*: \`http://server.com:80/playlist.m3u\`\n` +
        `- *TS/HLS*: \`http://server.com:80/stream.ts\`\n` +
        `- *JSON*: \`http://server.com:80/list.json\`\n` +
        `- *XML*: \`http://server.com:80/list.xml\`\n\n` +
        `🚀 *${botName} - Tu aliado en IPTV*${adminMessage}`;

      await bot.sendMessage(chatId, helpMessage, {
        parse_mode: 'Markdown',
        message_thread_id: allowedThreadId,
        ...mainMenu
      });
    } else if (query.data.startsWith('vote_')) {
      const [_, voteType, listId] = query.data.split('_');
      const { data: existingVote } = await supabase
        .from('votes')
        .select('*')
        .eq('list_id', listId)
        .eq('user_id', userId)
        .single();

      if (existingVote) {
        await bot.sendMessage(chatId, `❌ ${userMention}, ya has votado por esta lista.${adminMessage}`, {
          parse_mode: 'Markdown',
          message_thread_id: allowedThreadId
        });
        return;
      }

      await supabase
        .from('votes')
        .insert({ list_id: listId, user_id: userId, vote_type: voteType });

      const { data: votes } = await supabase
        .from('votes')
        .select('vote_type')
        .eq('list_id', listId);

      const upvotes = votes.filter(v => v.vote_type === 'upvote').length;
      const downvotes = votes.filter(v => v.vote_type === 'downvote').length;

      const { data: list } = await supabase
        .from('public_lists')
        .select('*')
        .eq('id', listId)
        .single();

      const updatedText = `📡 *Lista*: [${escapeMarkdown(list.url)}](${list.url})\n` +
        `💬 *Estado*: ${list.status}\n` +
        `📺 *Canales*: ${list.total_channels || 'Desconocido'}\n` +
        `⏰ *Expira*: ${list.expires_at || 'Desconocida'}\n` +
        `👍 *Me gusta*: ${upvotes} | 👎 *No funciona*: ${downvotes}${adminMessage}`;

      await bot.editMessageText(updatedText, {
        chat_id: chatId,
        message_id: messageId,
        message_thread_id: allowedThreadId,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: `👍 Me gusta (${upvotes})`, callback_data: `vote_upvote_${listId}` },
              { text: `👎 No funciona (${downvotes})`, callback_data: `vote_downvote_${listId}` }
            ]
          ]
        }
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

// Comandos
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
    `- *🔍 /guia* - Muestra esta guía de uso.\n` +
    `- *💾 /save [nombre]* - Guarda la última lista verificada con un nombre.\n` +
    `- *📜 /baul* - Lista todas tus listas guardadas.\n` +
    `- *✅ /registro* - Muestra tus listas activas, ordenadas por fecha de caducidad.\n` +
    `- *🎁 /generar* - Obtiene listas IPTV gratuitas verificadas de múltiples fuentes.\n` +
    `- *📚 /listaspublicas* - Muestra las listas públicas más recientes con votación.\n\n` +
    `🔧 *Cómo usar el bot*:\n` +
    `1️⃣ Usa los botones o envía un enlace IPTV válido.\n` +
    `2️⃣ Recibe un informe detallado al instante.\n\n` +
    `📡 *Formatos compatibles*:\n` +
    `- *Xtream*: \`http://server.com:80/get.php?username=xxx&password=yyy\`\n` +
    `- *M3U/M3U8*: \`http://server.com:80/playlist.m3u\`\n` +
    `- *TS/HLS*: \`http://server.com:80/stream.ts\`\n` +
    `- *JSON*: \`http://server.com:80/list.json\`\n` +
    `- *XML*: \`http://server.com:80/list.xml\`\n\n` +
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
    `- *🔍 /guia* - Muestra la guía básica para usuarios.\n` +
    `- *💾 /save [nombre]* - Guarda la última lista verificada con un nombre personalizado.\n` +
    `- *📜 /baul* - Muestra todas las listas guardadas del usuario.\n` +
    `- *✅ /registro* - Lista las listas activas guardadas, ordenadas por fecha de caducidad.\n` +
    `- *🎁 /generar* - Genera y verifica listas IPTV gratuitas de múltiples fuentes.\n` +
    `- *📚 /listaspublicas* - Muestra las listas públicas más recientes con votación.\n\n` +
    `🔒 *Comandos de Administración* (solo aquí):\n` +
    `- *📊 /historial* - Muestra el historial completo de verificaciones de todos los usuarios.\n` +
    `- *🌟 /iptv* - Comando de bienvenida inicial (uso interno).\n\n` +
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

// Comando /baul
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

// Comando /registro
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

// Obtener eventos deportivos desde TheSportsDB
async function getSportsEvents() {
  try {
    const response = await axiosInstance.get('https://www.thesportsdb.com/api/v1/json/3/eventsday.php?d=' + new Date().toISOString().split('T')[0]);
    return response.data.events || [];
  } catch (error) {
    logAction('sports_events_error', { error: error.message });
    return [];
  }
}

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
    // Fuentes estáticas (repositorios públicos)
    const staticSources = [
      { url: 'https://iptv-org.github.io/iptv/countries/es.m3u', category: 'España', type: 'country' },
      { url: 'https://iptv-org.github.io/iptv/languages/spa.m3u', category: 'Español', type: 'language' },
      { url: 'https://raw.githubusercontent.com/iptv-org/iptv/master/streams/es.m3u', category: 'España', type: 'country' },
      { url: 'https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8', category: 'General', type: 'general' },
      { url: 'https://raw.githubusercontent.com/iptv-restream/iptv-channels/master/channels/es.m3u', category: 'España', type: 'country' },
      { url: 'https://raw.githubusercontent.com/LaSaleta/tv/main/lista.m3u', category: 'España', type: 'country' },
      { url: 'https://raw.githubusercontent.com/iptv-org/iptv/master/streams/mx.m3u', category: 'México', type: 'country' },
      { url: 'https://raw.githubusercontent.com/iptv-org/iptv/master/streams/ar.m3u', category: 'Argentina', type: 'country' },
      { url: 'https://raw.githubusercontent.com/iptv-org/iptv/master/streams/us.m3u', category: 'USA', type: 'country' },
      { url: 'https://raw.githubusercontent.com/iptv-org/iptv/master/streams/uk.m3u', category: 'UK', type: 'country' },
      { url: 'https://raw.githubusercontent.com/iptv-org/iptv/master/streams/sports.m3u', category: 'Deportes', type: 'sports' },
      { url: 'https://raw.githubusercontent.com/iptv-org/iptv/master/streams/movies.m3u', category: 'Películas', type: 'movies' },
      { url: 'https://raw.githubusercontent.com/iptv-org/iptv/master/streams/music.m3u', category: 'Música', type: 'music' },
      { url: 'https://www.tdtchannels.com/lists/tv.m3u8', category: 'España (TDT)', type: 'tdt' },
      { url: 'https://iptvcat.net/static/uploads/iptv_list_66ebeb47eecf0.m3u', category: 'General', type: 'iptvcat' },
      { url: 'https://m3u.cl/lista.m3u', category: 'General', type: 'general' },
      { url: 'https://iptv-org.github.io/iptv/categories/news.m3u', category: 'Noticias', type: 'category' },
      { url: 'https://iptv-org.github.io/iptv/categories/kids.m3u', category: 'Infantil', type: 'category' },
      { url: 'https://iptv-org.github.io/iptv/categories/adult.m3u', category: 'Adultos', type: 'category' },
      { url: 'https://raw.githubusercontent.com/iptv-org/iptv/master/streams/premium.m3u', category: 'Premium', type: 'premium' },
      { url: 'https://iptv-org.github.io/iptv/categories/premium.m3u', category: 'Premium', type: 'premium' }
    ];

    // Fuentes dinámicas desde APIs públicas
    const dynamicSources = [];

    // API de IPTVCat
    try {
      const iptvCatResponse = await axiosInstance.get('https://iptvcat.com/spain/');
      const iptvCatLinks = iptvCatResponse.data.match(/(http[s]?:\/\/[^\s]+\.m3u)/g) || [];
      dynamicSources.push(...iptvCatLinks.map(url => ({ url, category: 'España (IPTVCat)', type: 'iptvcat' })));
    } catch (error) {
      logAction('iptvcat_error', { error: error.message });
    }

    // API de TDTChannels
    try {
      const tdtResponse = await axiosInstance.get('https://www.tdtchannels.com/lists/radio_and_tv.m3u8');
      if (tdtResponse.status === 200) {
        dynamicSources.push({ url: 'https://www.tdtchannels.com/lists/radio_and_tv.m3u8', category: 'España (TDTChannels)', type: 'tdt' });
      }
    } catch (error) {
      logAction('tdtchannels_error', { error: error.message });
    }

    // Combinar fuentes y evitar repeticiones
    const allSources = [...staticSources, ...dynamicSources].filter(source => !publicLists.includes(source.url));
    const lists = [];
    const errors = [];

    for (const source of allSources) {
      const loadingListMessage = await bot.sendMessage(chatId, `🔄 ${userMention}, procesando ${source.url} (${source.category})...${adminMessage}`, {
        parse_mode: 'Markdown',
        message_thread_id: allowedThreadId
      });

      await showListAnimation(chatId, allowedThreadId, loadingListMessage.message_id, `🔄 ${userMention}, procesando ${source.url} (${source.category})...`, source.type);

      try {
        const response = await axiosInstance.get(source.url, { timeout: 15000 });
        if (response.status === 200) {
          const result = await checkIPTVList(source.url, userId);
          lists.push({ url: source.url, type: source.url.endsWith('.m3u8') ? 'M3U8' : source.url.endsWith('.json') ? 'JSON' : source.url.endsWith('.xml') ? 'XML' : 'M3U', category: source.category, status: result.status, totalChannels: result.totalChannels, expiresAt: result.expiresAt });
          publicLists.push(source.url);
          if (publicLists.length > 100) publicLists.shift();

          await bot.editMessageText(`✅ ${userMention}, lista procesada: ${source.url} (${source.category})\n- Estado: ${result.status}\n- Canales: ${result.totalChannels || 'Desconocido'}\n- Expira: ${result.expiresAt || 'Desconocida'}${adminMessage}`, {
            chat_id: chatId,
            message_id: loadingListMessage.message_id,
            message_thread_id: allowedThreadId,
            parse_mode: 'Markdown'
          });
        }
      } catch (error) {
        errors.push(`- ${source.url} (${source.category}): ${error.message}`);
        await bot.editMessageText(`❌ ${userMention}, error al procesar ${source.url} (${source.category}): ${error.message}${adminMessage}`, {
          chat_id: chatId,
          message_id: loadingListMessage.message_id,
          message_thread_id: allowedThreadId,
          parse_mode: 'Markdown'
        });
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

    // Guardar listas en Supabase
    for (const list of lists) {
      await supabase
        .from('public_lists')
        .insert({
          url: list.url,
          type: list.type,
          category: list.category,
          status: list.status,
          total_channels: list.totalChannels || 0,
          expires_at: list.expiresAt || 'Desconocida',
          last_checked: new Date().toISOString()
        });
    }

    // Obtener eventos deportivos
    let sportsMessage = '';
    const sportsLists = lists.filter(list => list.category.toLowerCase().includes('deportes'));
    if (sportsLists.length > 0) {
      const events = await getSportsEvents();
      if (events.length > 0) {
        sportsMessage = `\n\n⚽ *Eventos deportivos de hoy*:\n`;
        for (const event of events.slice(0, 3)) {
          sportsMessage += `- ${event.strEvent} (${event.dateEvent} ${event.strTime})\n` +
                           `  📺 Disponible en listas de deportes: [Ver listas](#deportes)\n`;
        }
      }
    }

    let responseText = `🎉 ${userMention}, generación de listas completada:\n\n` +
                      `💡 Usa /save [nombre] para guardar una lista.\n` +
                      `📚 Usa /listaspublicas para ver todas las listas públicas con votación.\n` +
                      sportsMessage +
                      adminMessage;

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

// Comando /listaspublicas
bot.onText(/\/listaspublicas/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const allowedThreadId = getAllowedThreadId(chatId);
  const userMention = getUserMention(msg.from);
  if (!isAllowedContext(chatId, msg.message_thread_id || '0')) return;

  const { data: lists, error } = await supabase
    .from('public_lists')
    .select('*')
    .order('last_checked', { ascending: false })
    .limit(10);

  if (error || !lists.length) {
    await bot.sendMessage(chatId, `📚 ${userMention}, no hay listas públicas disponibles en este momento.${adminMessage}`, {
      parse_mode: 'Markdown',
      message_thread_id: allowedThreadId
    });
    return;
  }

  let responseText = `📚 *Listas públicas más recientes*:\n\n`;
  for (const list of lists) {
    const { data: votes } = await supabase
      .from('votes')
      .select('vote_type')
      .eq('list_id', list.id);

    const upvotes = votes.filter(v => v.vote_type === 'upvote').length;
    const downvotes = votes.filter(v => v.vote_type === 'downvote').length;

    responseText = `- *${list.type} (${list.category})*: [${escapeMarkdown(list.url)}](${list.url})\n` +
                  `  - Estado: ${list.status}\n` +
                  `  - Canales: ${list.total_channels || 'Desconocido'}\n` +
                  `  - Expira: ${list.expires_at || 'Desconocida'}\n` +
                  `  - 👍 Me gusta: ${upvotes} | 👎 No funciona: ${downvotes}\n\n`;

    await bot.sendMessage(chatId, responseText, {
      parse_mode: 'Markdown',
      message_thread_id: allowedThreadId,
      reply_markup: {
        inline_keyboard: [
          [
            { text: `👍 Me gusta (${upvotes})`, callback_data: `vote_upvote_${list.id}` },
            { text: `👎 No funciona (${downvotes})`, callback_data: `vote_downvote_${list.id}` }
          ]
        ]
      }
    });
    responseText = ''; // Resetear para el próximo mensaje
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
        `- *TS/HLS*: \`http://server.com:80/stream.ts\`\n` +
        `- *JSON*: \`http://server.com:80/list.json\`\n` +
        `- *XML*: \`http://server.com:80/list.xml\`\n\n` +
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

// Generar listas públicas cada 24 horas a las 12:00 PM (hora de España)
cron.schedule('0 12 * * *', async () => {
  const chatId = ALLOWED_CHAT_IDS[0].chatId;
  const allowedThreadId = getAllowedThreadId(chatId);
  await bot.sendMessage(chatId, `⏳ Generando nuevas listas públicas...${adminMessage}`, {
    parse_mode: 'Markdown',
    message_thread_id: allowedThreadId
  });

  const staticSources = [
    { url: 'https://iptv-org.github.io/iptv/countries/es.m3u', category: 'España', type: 'country' },
    { url: 'https://iptv-org.github.io/iptv/languages/spa.m3u', category: 'Español', type: 'language' },
    { url: 'https://raw.githubusercontent.com/iptv-org/iptv/master/streams/es.m3u', category: 'España', type: 'country' },
    { url: 'https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8', category: 'General', type: 'general' },
    { url: 'https://raw.githubusercontent.com/iptv-restream/iptv-channels/master/channels/es.m3u', category: 'España', type: 'country' },
    { url: 'https://raw.githubusercontent.com/LaSaleta/tv/main/lista.m3u', category: 'España', type: 'country' },
    { url: 'https://raw.githubusercontent.com/iptv-org/iptv/master/streams/mx.m3u', category: 'México', type: 'country' },
    { url: 'https://raw.githubusercontent.com/iptv-org/iptv/master/streams/ar.m3u', category: 'Argentina', type: 'country' },
    { url: 'https://raw.githubusercontent.com/iptv-org/iptv/master/streams/us.m3u', category: 'USA', type: 'country' },
    { url: 'https://raw.githubusercontent.com/iptv-org/iptv/master/streams/uk.m3u', category: 'UK', type: 'country' },
    { url: 'https://raw.githubusercontent.com/iptv-org/iptv/master/streams/sports.m3u', category: 'Deportes', type: 'sports' },
    { url: 'https://raw.githubusercontent.com/iptv-org/iptv/master/streams/movies.m3u', category: 'Películas', type: 'movies' },
    { url: 'https://raw.githubusercontent.com/iptv-org/iptv/master/streams/music.m3u', category: 'Música', type: 'music' },
    { url: 'https://www.tdtchannels.com/lists/tv.m3u8', category: 'España (TDT)', type: 'tdt' },
    { url: 'https://iptvcat.net/static/uploads/iptv_list_66ebeb47eecf0.m3u', category: 'General', type: 'iptvcat' },
    { url: 'https://m3u.cl/lista.m3u', category: 'General', type: 'general' },
    { url: 'https://iptv-org.github.io/iptv/categories/news.m3u', category: 'Noticias', type: 'category' },
    { url: 'https://iptv-org.github.io/iptv/categories/kids.m3u', category: 'Infantil', type: 'category' },
    { url: 'https://iptv-org.github.io/iptv/categories/adult.m3u', category: 'Adultos', type: 'category' },
    { url: 'https://raw.githubusercontent.com/iptv-org/iptv/master/streams/premium.m3u', category: 'Premium', type: 'premium' },
    { url: 'https://iptv-org.github.io/iptv/categories/premium.m3u', category: 'Premium', type: 'premium' }
  ];

  const dynamicSources = [];
  try {
    const iptvCatResponse = await axiosInstance.get('https://iptvcat.com/spain/');
    const iptvCatLinks = iptvCatResponse.data.match(/(http[s]?:\/\/[^\s]+\.m3u)/g) || [];
    dynamicSources.push(...iptvCatLinks.map(url => ({ url, category: 'España (IPTVCat)', type: 'iptvcat' })));
  } catch (error) {
    logAction('iptvcat_error', { error: error.message });
  }

  try {
    const tdtResponse = await axiosInstance.get('https://www.tdtchannels.com/lists/tv.m3u8');
    if (tdtResponse.status === 200) {
      dynamicSources.push({ url: 'https://www.tdtchannels.com/lists/tv.m3u8', category: 'España (TDTChannels)', type: 'tdt' });
    }
  } catch (error) {
    logAction('tdtchannels_error', { error: error.message });
  }

  const allSources = [...staticSources, ...dynamicSources].filter(source => !publicLists.includes(source.url));
  const lists = [];

  for (const source of allSources) {
    try {
      const response = await axiosInstance.get(source.url, { timeout: 15000 });
      if (response.status === 200) {
        const result = await checkIPTVList(source.url, 'cron');
        lists.push({ url: source.url, type: source.url.endsWith('.m3u8') ? 'M3U8' : source.url.endsWith('.json') ? 'JSON' : source.url.endsWith('.xml') ? 'XML' : 'M3U', category: source.category, status: result.status, totalChannels: result.totalChannels, expiresAt: result.expiresAt });
        publicLists.push(source.url);
        if (publicLists.length > 100) publicLists.shift();
      }
    } catch (error) {
      logAction('cron_generate_error', { url: source.url, error: error.message });
    }
  }

  for (const list of lists) {
    await supabase
      .from('public_lists')
      .insert({
        url: list.url,
        type: list.type,
        category: list.category,
        status: list.status,
        total_channels: list.totalChannels || 0,
        expires_at: list.expiresAt || 'Desconocida',
        last_checked: new Date().toISOString()
      });
  }

  await bot.sendMessage(chatId, `✅ Nuevas listas públicas generadas. Usa /listaspublicas para verlas.${adminMessage}`, {
    parse_mode: 'Markdown',
    message_thread_id: allowedThreadId
  });
}, { scheduled: true, timezone: 'Europe/Madrid' });

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