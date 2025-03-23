import express from 'express';
import { Telegraf } from 'telegraf';
import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import axios from 'axios';
import xml2js from 'xml2js';
import cron from 'node-cron';

dotenv.config();

// Agregar depuración para verificar las variables de entorno
console.log('SUPABASE_URL:', process.env.SUPABASE_URL);
console.log('SUPABASE_KEY:', process.env.SUPABASE_KEY);
console.log('BOT_TOKEN:', process.env.BOT_TOKEN);
console.log('ADMIN_CHAT_ID:', process.env.ADMIN_CHAT_ID);

// Validar que BOT_TOKEN esté definido
if (!process.env.BOT_TOKEN) {
  console.error('Error: BOT_TOKEN is not defined. Please set the BOT_TOKEN environment variable.');
  process.exit(1); // Salir del proceso con un código de error
}

const app = express();
let bot;

try {
  bot = new Telegraf(process.env.BOT_TOKEN);
  console.log('Bot initialized successfully');
  console.log('bot.sendMessage exists:', typeof bot.sendMessage === 'function');
} catch (error) {
  console.error('Error initializing Telegraf bot:', error.message);
  process.exit(1); // Salir del proceso con un código de error
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Configuración de variables globales
const BOT_NAME = 'EntrelinksBot';
const PORT = process.env.PORT || 10000;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const ALLOWED_CHAT_IDS = [
  { chatId: ADMIN_CHAT_ID, threadId: null }
];
const processedUpdates = new Set();
const userStates = {};
const userHistory = {};
const publicLists = [];
const adminMessage = '\n\n👨‍💼 *Equipo de Administración EntresHijos*';

// Instancia de axios con timeout
const axiosInstance = axios.create({
  timeout: 10000,
  headers: { 'User-Agent': 'EntrelinksBot/1.0' }
});

// Configuración de Express
app.use(express.json());

// Fuentes de listas públicas
const publicSources = [
  { url: 'https://iptv-org.github.io/iptv/countries/es.m3u', category: 'España' },
  { url: 'https://iptv-org.github.io/iptv/languages/spa.m3u', category: 'Español' },
  { url: 'https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8', category: 'General' },
  { url: 'https://raw.githubusercontent.com/iptv-org/iptv/master/streams/mx.m3u', category: 'México' },
  { url: 'https://raw.githubusercontent.com/iptv-org/iptv/master/streams/ar.m3u', category: 'Argentina' },
  { url: 'https://raw.githubusercontent.com/iptv-org/iptv/master/streams/us.m3u', category: 'USA' },
  { url: 'https://raw.githubusercontent.com/iptv-org/iptv/master/streams/uk.m3u', category: 'UK' },
  { url: 'https://raw.githubusercontent.com/iptv-org/iptv/master/streams/sports.m3u', category: 'Deportes' },
  { url: 'https://iptvcat.net/static/uploads/iptv_list_66ebeb47eecf0.m3u', category: 'General' },
  { url: 'https://m3u.cl/lista.m3u', category: 'General' },
  { url: 'https://iptv-org.github.io/iptv/categories/movies.m3u', category: 'Películas' },
  { url: 'https://iptv-org.github.io/iptv/categories/news.m3u', category: 'Noticias' }
];

// Funciones utilitarias
function logAction(action, data) {
  console.log(`[${new Date().toLocaleString()}] ${action}:`, data);
}

function getUserMention(user) {
  return user.username ? `@${user.username}` : user.first_name || 'Usuario';
}

function escapeMarkdown(text) {
  return text.replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

// Función para verificar si una tabla existe
async function checkTableExists(table) {
  try {
    const { data, error } = await supabase.rpc('table_exists', { table_name: table });
    if (error) throw error;
    return data;
  } catch (error) {
    logAction('table_exists_error', { table, error: error.message });
    return false;
  }
}

// Función para reestructurar la base de datos
async function restructureDatabase() {
  const tables = [
    {
      name: 'public_lists',
      createQuery: `
        CREATE TABLE public.public_lists (
          id SERIAL PRIMARY KEY,
          url TEXT NOT NULL,
          type TEXT NOT NULL,
          category TEXT NOT NULL,
          status TEXT NOT NULL,
          total_channels INTEGER,
          expires_at TEXT,
          last_checked TIMESTAMP DEFAULT NOW()
        );
        CREATE INDEX idx_public_lists_last_checked ON public.public_lists (last_checked);
      `
    },
    {
      name: 'votes',
      createQuery: `
        CREATE TABLE public.votes (
          id SERIAL PRIMARY KEY,
          list_id INTEGER REFERENCES public.public_lists(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL,
          vote_type TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT NOW()
        );
      `
    },
    {
      name: 'mirrors',
      createQuery: `
        CREATE TABLE public.mirrors (
          id SERIAL PRIMARY KEY,
          original_url TEXT NOT NULL,
          mirror_url TEXT NOT NULL,
          status TEXT DEFAULT 'Pending',
          last_checked TIMESTAMP DEFAULT NOW()
        );
      `
    }
  ];

  for (const table of tables) {
    const exists = await checkTableExists(table.name);
    if (!exists) {
      try {
        const { error } = await supabase.rpc('execute_sql', { sql: table.createQuery });
        if (error) throw error;
        logAction('table_created', { table: table.name });
      } catch (error) {
        logAction('database_restructure_error', { table: table.name, error: error.message });
      }
    }
  }
}

// Función para verificar una lista IPTV
async function checkIPTVList(url, userId) {
  logAction('check_start', { url });
  try {
    url = ensurePort(url.trim());

    if (url.includes('get.php')) {
      const [, params] = url.split('?');
      const queryParams = Object.fromEntries(new URLSearchParams(params));
      const { username, password } = queryParams;
      const server = url.split('/get.php')[0];
      const apiUrl = `${server}/player_api.php?username=${username}&password=${password}`;

      const response = await axiosInstance.get(apiUrl);
      const { user_info, server_info } = response.data;

      if (!user_info || !server_info) {
        throw new Error('Respuesta de la API Xtream Codes no contiene user_info o server_info');
      }

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

    if (url.endsWith('.m3u') || url.endsWith('.m3u8') || url.includes('playlist')) {
      let response;
      try {
        response = await axiosInstance.get(url);
      } catch (error) {
        if (error.response?.status === 401 || error.response?.status === 403) {
          const urlObj = new URL(url);
          const username = urlObj.username || 'guest';
          const password = urlObj.password || 'guest';
          response = await axiosInstance.get(url, { auth: { username, password } });
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
      if (error.response.status === 403) errorMsg = 'Acceso denegado (403)';
      else if (error.response.status === 404) errorMsg = 'No encontrado (404)';
      else errorMsg = `Error del servidor (${error.response.status})`;
    } else if (error.message.includes('timeout')) {
      errorMsg = 'Tiempo agotado';
    } else {
      errorMsg = `Error: ${error.message}`;
    }
    logAction('check_error', { url, error: errorMsg });
    return { type: 'Desconocido', status: 'Error', error: errorMsg, server: url.split('/').slice(0, 3).join('/'), expiresAt: 'Desconocida' };
  }
}

// Función para formatear la respuesta
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

  const response = `✨ Hola ${userMention}, aquí tienes los detalles de tu lista IPTV ✨\n\n` +
    `📅 *Fecha y hora*: ${timestamp}\n` +
    `📡 *Lista*: [${escapeMarkdown(originalUrl)}](${originalUrl})\n` +
    `💬 *Estado*: ${messageText}\n` +
    `🔑 *Combo*: ${combo}\n` +
    `📅 *Creada*: ${result.createdAt || 'No disponible'}\n` +
    `⏰ *Expira*: ${result.expiresAt || 'No disponible'}\n` +
    `🔗 *Conexiones*: ${result.activeConnections !== undefined ? `${result.activeConnections}/${result.maxConnections}` : 'No disponible'}\n` +
    `📺 *Canales*: ${result.totalChannels || 0}\n` +
    `🌐 *Servidor Real*: [${escapeMarkdown(serverReal)}](${serverReal})\n` +
    `⏲ *Zona horaria*: ${result.timezone || 'Desconocida'}\n\n` +
    `🚀 *${BOT_NAME} - Verificación Profesional y Gratuita*${adminMessage}`;

  return { text: response };
}

// Función para generar listas públicas
async function generatePublicLists() {
  const chatId = ALLOWED_CHAT_IDS[0].chatId;
  const threadId = getAllowedThreadId(chatId);

  try {
    await bot.sendMessage(chatId, `⏳ Generando nuevas listas públicas...${adminMessage}`, {
      parse_mode: 'Markdown',
      message_thread_id: threadId
    });
  } catch (error) {
    console.error('Error sending message in generatePublicLists:', error.message);
    return; // Salir de la función si no se puede enviar el mensaje
  }

  const sourcesToProcess = publicSources.slice(0, 5);

  for (const source of sourcesToProcess) {
    if (publicLists.includes(source.url)) continue;

    const result = await checkIPTVList(source.url, 'cron');
    if (result.status === 'Activa') {
      const { error } = await supabase.from('public_lists').insert({
        url: source.url,
        type: source.url.endsWith('.m3u8') ? 'M3U8' : source.url.endsWith('.json') ? 'JSON' : source.url.endsWith('.xml') ? 'XML' : 'M3U',
        category: source.category,
        status: result.status,
        total_channels: result.totalChannels || 0,
        expires_at: result.expiresAt || 'Desconocida',
        last_checked: new Date().toISOString()
      });

      if (error) {
        logAction('insert_public_list_error', { url: source.url, error: error.message });
        continue;
      }

      publicLists.push(source.url);
      if (publicLists.length > 100) publicLists.shift();
    }
  }

  try {
    await bot.sendMessage(chatId, `✅ Nuevas listas públicas generadas.\nUsa /listaspublicas para verlas.${adminMessage}`, {
      parse_mode: 'Markdown',
      message_thread_id: threadId
    });
  } catch (error) {
    console.error('Error sending completion message in generatePublicLists:', error.message);
  }
}

// Función para manejar listas públicas
async function handlePublicLists(ctx) {
  const chatId = ctx.chat.id;
  const threadId = ctx.message?.message_thread_id || '0';
  const userId = ctx.from.id;
  const userMention = getUserMention(ctx.from);
  const allowedThreadId = getAllowedThreadId(chatId);

  if (!isAllowedContext(chatId, threadId)) return;

  const loadingMessage = await ctx.reply(`⏳ ${userMention}, cargando listas públicas...${adminMessage}`, {
    parse_mode: 'Markdown',
    message_thread_id: allowedThreadId
  });

  const { data: lists, error } = await supabase
    .from('public_lists')
    .select('*')
    .order('last_checked', { ascending: false })
    .limit(5);

  if (error) {
    logAction('fetch_public_lists_error', { error: error.message });
    await ctx.reply(`❌ ${userMention}, error al cargar listas públicas: ${error.message}${adminMessage}`, {
      parse_mode: 'Markdown',
      message_thread_id: allowedThreadId
    });
    return;
  }

  if (!lists || lists.length === 0) {
    await ctx.reply(`📚 ${userMention}, no hay listas públicas disponibles en este momento. Usa "Generar Listas" para crear nuevas.${adminMessage}`, {
      parse_mode: 'Markdown',
      message_thread_id: allowedThreadId
    });
    return;
  }

  let responseText = `📚 *Listas públicas más recientes*:\n\n`;
  const keyboard = [];
  for (const list of lists) {
    const { data: votes } = await supabase
      .from('votes')
      .select('vote_type')
      .eq('list_id', list.id);

    const upvotes = votes?.filter(v => v.vote_type === 'upvote').length || 0;
    const downvotes = votes?.filter(v => v.vote_type === 'downvote').length || 0;

    responseText += `📋 *${list.type} (${list.category})*: [${escapeMarkdown(list.url)}](${list.url})\n` +
      `  - Estado: ${list.status}\n` +
      `  - Canales: ${list.total_channels || 'Desconocido'}\n` +
      `  - Expira: ${list.expires_at || 'Desconocida'}\n` +
      `  - 👍 ${upvotes} | 👎 ${downvotes}\n\n`;
    keyboard.push([
      { text: `👍 ${upvotes}`, callback_data: `vote_up_${list.id}` },
      { text: `👎 ${downvotes}`, callback_data: `vote_down_${list.id}` }
    ]);
  }
  responseText += adminMessage;

  keyboard.push([{ text: '⬅️ Regresar', callback_data: 'back_to_main' }]);

  await bot.editMessageText(responseText, {
    chat_id: chatId,
    message_id: loadingMessage.message_id,
    message_thread_id: allowedThreadId,
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
}

// Menú principal
const mainMenu = {
  reply_markup: {
    inline_keyboard: [
      [
        { text: '🔎 Verificar Lista', callback_data: 'check' },
        { text: '🎁 Generar Listas', callback_data: 'generate' }
      ],
      [
        { text: '📚 Listas Públicas', callback_data: 'public_lists' },
        { text: '🪞 Buscar Espejo', callback_data: 'mirror' }
      ],
      [
        { text: 'ℹ️ Ayuda', callback_data: 'guia' },
        { text: '📜 Historial', callback_data: 'historial' }
      ]
    ]
  }
};

// Funciones utilitarias adicionales
function isAllowedContext(chatId, threadId) {
  const group = ALLOWED_CHAT_IDS.find(g => g.chatId === String(chatId));
  if (!group) return false;
  return group.threadId ? String(threadId) === group.threadId : true;
}

function getAllowedThreadId(chatId) {
  const group = ALLOWED_CHAT_IDS.find(g => g.chatId === String(chatId));
  return group ? group.threadId : null;
}

function ensurePort(url) {
  if (!url.startsWith('http')) url = `http://${url}`;
  const urlObj = new URL(url);
  if (!urlObj.port) urlObj.port = urlObj.protocol === 'https:' ? '443' : '80';
  return urlObj.toString();
}

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

// Comando /start
bot.command('start', async (ctx) => {
  const userMention = getUserMention(ctx.from);
  await ctx.reply(`👋 ¡Bienvenido a ${BOT_NAME}, ${userMention}! Usa /iptv para ver las opciones disponibles.`, {
    parse_mode: 'Markdown'
  });
});

// Comando /iptv
bot.command('iptv', async (ctx) => {
  const chatId = ctx.chat.id;
  const threadId = ctx.message?.message_thread_id || '0';
  const userMention = getUserMention(ctx.from);
  const allowedThreadId = getAllowedThreadId(chatId);

  if (!isAllowedContext(chatId, threadId)) return;

  const response = `🌟 ¡Hola ${userMention}! Bienvenido a *${BOT_NAME}* 🌟\n\n` +
    `✅ Verifica tus listas IPTV de forma gratuita y rápida.\n` +
    `🔧 Usa los botones para navegar por las opciones.\n\n` +
    `👨‍💼 *Equipo de Administración EntresHijos*`;
  await ctx.reply(response, {
    parse_mode: 'Markdown',
    message_thread_id: allowedThreadId,
    ...mainMenu
  });
});

// Comando /generar
bot.command('generar', async (ctx) => {
  const chatId = ctx.chat.id;
  const threadId = ctx.message?.message_thread_id || '0';
  const userId = ctx.from.id;
  const userMention = getUserMention(ctx.from);
  const allowedThreadId = getAllowedThreadId(chatId);

  if (!isAllowedContext(chatId, threadId)) return;

  await handleGenerate(ctx, chatId, allowedThreadId, userId, userMention);
});

// Comando /listaspublicas
bot.command('listaspublicas', handlePublicLists);

// Comando /espejo
bot.command('espejo', async (ctx) => {
  const chatId = ctx.chat.id;
  const threadId = ctx.message?.message_thread_id || '0';
  const userId = ctx.from.id;
  const userMention = getUserMention(ctx.from);
  const allowedThreadId = getAllowedThreadId(chatId);

  if (!isAllowedContext(chatId, threadId)) return;

  userStates[userId] = { action: 'mirror' };
  await ctx.reply(`🪞 ${userMention}, envía la URL de la lista IPTV para buscar un servidor espejo: 📡${adminMessage}`, {
    parse_mode: 'Markdown',
    message_thread_id: allowedThreadId,
    ...mainMenu
  });
});

// Comando /historial
bot.command('historial', async (ctx) => {
  const chatId = ctx.chat.id;
  const threadId = ctx.message?.message_thread_id || '0';
  const userId = ctx.from.id;
  const userMention = getUserMention(ctx.from);
  const allowedThreadId = getAllowedThreadId(chatId);

  if (!isAllowedContext(chatId, threadId)) return;

  if (!userHistory[userId] || userHistory[userId].length === 0) {
    await ctx.reply(`📜 ${userMention}, no tienes verificaciones recientes.${adminMessage}`, {
      parse_mode: 'Markdown',
      message_thread_id: allowedThreadId,
      ...mainMenu
    });
    return;
  }

  let historyText = `📜 *Historial de verificaciones de ${userMention}*:\n\n`;
  userHistory[userId].forEach((entry, index) => {
    const timestamp = entry.timestamp.toLocaleString('es-ES', { timeZone: 'America/Mexico_City' });
    historyText += `${index + 1}. 📅 ${timestamp} - [${escapeMarkdown(entry.url)}](${entry.url}) - ${entry.result.status}\n`;
  });
  historyText += adminMessage;

  await ctx.reply(historyText, {
    parse_mode: 'Markdown',
    message_thread_id: allowedThreadId,
    reply_markup: {
      inline_keyboard: [
        [{ text: '⬅️ Regresar', callback_data: 'back_to_main' }]
      ]
    }
  });
});

// Manejo de botones
bot.on('callback_query', async (ctx) => {
  const chatId = ctx.chat.id;
  const threadId = ctx.update.callback_query.message?.message_thread_id || '0';
  const userId = ctx.from.id;
  const userMention = getUserMention(ctx.from);
  const allowedThreadId = getAllowedThreadId(chatId);

  if (!isAllowedContext(chatId, threadId)) return;

  try {
    await ctx.answerCbQuery();

    if (!userStates[userId]) userStates[userId] = {};

    if (ctx.callbackQuery.data === 'check') {
      userStates[userId].action = 'check';
      await ctx.editMessageText(`🔎 ${userMention}, envía un enlace IPTV válido (M3U, Xtream, TS, JSON, XML, etc.): 📡${adminMessage}`, {
        parse_mode: 'Markdown',
        message_thread_id: allowedThreadId
      });
    } else if (ctx.callbackQuery.data === 'generate') {
      await handleGenerate(ctx, chatId, allowedThreadId, userId, userMention);
    } else if (ctx.callbackQuery.data === 'public_lists') {
      await handlePublicLists(ctx);
    } else if (ctx.callbackQuery.data === 'mirror') {
      userStates[userId].action = 'mirror';
      await ctx.editMessageText(`🪞 ${userMention}, envía la URL de la lista IPTV para buscar un servidor espejo: 📡${adminMessage}`, {
        parse_mode: 'Markdown',
        message_thread_id: allowedThreadId
      });
    } else if (ctx.callbackQuery.data === 'guia') {
      const helpMessage = `🌟 *Bienvenido a ${BOT_NAME}, ${userMention}!* 🌟\n\n` +
        `👋 Somos un bot profesional y gratuito exclusivo para *EntresHijos*, diseñado para gestionar y verificar listas IPTV.\n\n` +
        `📋 *Comandos disponibles*:\n` +
        `- *🔍 /iptv* - Inicia el bot.\n` +
        `- *🪞 /espejo* - Busca servidores espejo para una lista IPTV.\n` +
        `- *🎁 /generar* - Genera listas IPTV gratuitas.\n` +
        `- *📚 /listaspublicas* - Muestra listas públicas con votación.\n` +
        `- *📜 /historial* - Muestra tu historial de verificaciones.\n\n` +
        `🔧 *Cómo usar el bot*:\n` +
        `1️⃣ Usa los botones o comandos.\n` +
        `2️⃣ Envía un enlace IPTV para verificar.\n` +
        `3️⃣ Explora listas públicas o busca espejos.\n\n` +
        `📡 *Formatos compatibles*:\n` +
        `- *Xtream*: \`http://server.com:80/get.php?username=xxx&password=yyy\`\n` +
        `- *M3U/M3U8*: \`http://server.com:80/playlist.m3u\`\n` +
        `- *TS/HLS*: \`http://server.com:80/stream.ts\`\n` +
        `- *JSON*: \`http://server.com:80/list.json\`\n` +
        `- *XML*: \`http://server.com:80/list.xml\`\n\n` +
        `🚀 *${BOT_NAME} - Tu aliado en IPTV*${adminMessage}`;

      await ctx.editMessageText(helpMessage, {
        parse_mode: 'Markdown',
        message_thread_id: allowedThreadId,
        ...mainMenu
      });
    } else if (ctx.callbackQuery.data === 'historial') {
      if (!userHistory[userId] || userHistory[userId].length === 0) {
        await ctx.editMessageText(`📜 ${userMention}, no tienes verificaciones recientes.${adminMessage}`, {
          parse_mode: 'Markdown',
          message_thread_id: allowedThreadId,
          ...mainMenu
        });
        return;
      }

      let historyText = `📜 *Historial de verificaciones de ${userMention}*:\n\n`;
      userHistory[userId].forEach((entry, index) => {
        const timestamp = entry.timestamp.toLocaleString('es-ES', { timeZone: 'America/Mexico_City' });
        historyText += `${index + 1}. 📅 ${timestamp} - [${escapeMarkdown(entry.url)}](${entry.url}) - ${entry.result.status}\n`;
      });
      historyText += adminMessage;

      await ctx.editMessageText(historyText, {
        parse_mode: 'Markdown',
        message_thread_id: allowedThreadId,
        reply_markup: {
          inline_keyboard: [
            [{ text: '⬅️ Regresar', callback_data: 'back_to_main' }]
          ]
        }
      });
    } else if (ctx.callbackQuery.data.startsWith('vote_')) {
      const [, voteType, listId] = ctx.callbackQuery.data.split('_');
      const { data: existingVote } = await supabase
        .from('votes')
        .select('*')
        .eq('list_id', listId)
        .eq('user_id', userId)
        .single();

      if (existingVote) {
        await ctx.reply(`❌ ${userMention}, ya has votado por esta lista.${adminMessage}`, {
          parse_mode: 'Markdown',
          message_thread_id: allowedThreadId,
          reply_markup: {
            inline_keyboard: [
              [{ text: '⬅️ Regresar a Listas Públicas', callback_data: 'public_lists' }],
              [{ text: '🏠 Menú Principal', callback_data: 'back_to_main' }]
            ]
          }
        });
        return;
      }

      await supabase
        .from('votes')
        .insert({ list_id: listId, user_id: userId, vote_type: voteType });

      await handlePublicLists(ctx);
    } else if (ctx.callbackQuery.data === 'back_to_main') {
      const welcomeMessage = `🌟 ¡Hola ${userMention}! Bienvenido a *${BOT_NAME}* 🌟\n\n` +
        `✅ Verifica tus listas IPTV de forma gratuita y rápida.\n` +
        `🔧 Usa los botones para navegar por las opciones.\n\n` +
        `👨‍💼 *Equipo de Administración EntresHijos*`;
      await ctx.editMessageText(welcomeMessage, {
        parse_mode: 'Markdown',
        message_thread_id: allowedThreadId,
        ...mainMenu
      });
    }
  } catch (error) {
    logAction('callback_error', { action: ctx.callbackQuery.data, error: error.message });
    await ctx.reply(`❌ ${userMention}, error: ${error.message}${adminMessage}`, {
      parse_mode: 'Markdown',
      message_thread_id: allowedThreadId,
      ...mainMenu
    });
  }
});

// Procesar URLs IPTV
bot.on('message', async (ctx) => {
  const chatId = ctx.chat.id;
  const threadId = ctx.message?.message_thread_id || '0';
  const userId = ctx.from.id;
  const text = ctx.message.text || '';
  const userMention = getUserMention(ctx.from);
  const allowedThreadId = getAllowedThreadId(chatId);

  if (!isAllowedContext(chatId, threadId) || text.startsWith('/')) return;

  if (!userStates[userId]) userStates[userId] = {};

  const urlMatch = text.match(/(http|https):\/\/[^\s]+/);
  if (urlMatch && (userStates[userId].action === 'check' || userStates[userId].action === 'mirror')) {
    const url = urlMatch[0];

    if (!isValidIPTVFormat(url)) {
      await ctx.reply(`❌ ${userMention}, formato no válido. Usa un enlace IPTV soportado (M3U, Xtream, etc.).${adminMessage}`, {
        parse_mode: 'Markdown',
        message_thread_id: allowedThreadId,
        ...mainMenu
      });
      return;
    }

    if (userStates[userId].action === 'check') {
      const checkingMessage = await ctx.reply(`🔎 ${userMention}, verificando ${escapeMarkdown(url)}...${adminMessage}`, {
        parse_mode: 'Markdown',
        message_thread_id: allowedThreadId
      });

      const result = await checkIPTVList(url, userId);
      userHistory[userId] = userHistory[userId] || [];
      userHistory[userId].push({ url, result, timestamp: new Date() });
      if (userHistory[userId].length > 50) userHistory[userId].shift();

      const { text: responseText } = formatResponse(ctx, result, url);
      await bot.editMessageText(responseText, {
        chat_id: chatId,
        message_id: checkingMessage.message_id,
        message_thread_id: allowedThreadId,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '⬅️ Regresar', callback_data: 'back_to_main' }]
          ]
        }
      });
    } else if (userStates[userId].action === 'mirror') {
      await handleMirror(ctx, chatId, allowedThreadId, url, userId, userMention);
    }

    userStates[userId].action = null;
  }
});

// Función para manejar /generar
async function handleGenerate(ctx, chatId, threadId, userId, userMention) {
  const loadingMessage = await ctx.reply(`⏳ ${userMention}, buscando listas IPTV de múltiples fuentes...${adminMessage}`, {
    parse_mode: 'Markdown',
    message_thread_id: threadId
  });

  try {
    const sourcesToProcess = publicSources.slice(0, 5);
    const lists = [];

    for (const source of sourcesToProcess) {
      if (publicLists.includes(source.url)) continue;

      const result = await checkIPTVList(source.url, userId);
      if (result.status === 'Activa') {
        lists.push({
          url: source.url,
          type: source.url.endsWith('.m3u8') ? 'M3U8' : source.url.endsWith('.json') ? 'JSON' : source.url.endsWith('.xml') ? 'XML' : 'M3U',
          category: source.category,
          status: result.status,
          totalChannels: result.totalChannels,
          expiresAt: result.expiresAt
        });
        publicLists.push(source.url);
        if (publicLists.length > 100) publicLists.shift();

        const { error } = await supabase.from('public_lists').insert({
          url: source.url,
          type: source.url.endsWith('.m3u8') ? 'M3U8' : source.url.endsWith('.json') ? 'JSON' : source.url.endsWith('.xml') ? 'XML' : 'M3U',
          category: source.category,
          status: result.status,
          total_channels: result.totalChannels || 0,
          expires_at: result.expiresAt || 'Desconocida',
          last_checked: new Date().toISOString()
        });

        if (error) {
          logAction('insert_public_list_error', { url: source.url, error: error.message });
          throw new Error(`Error al insertar lista pública: ${error.message}`);
        }
      }
    }

    let responseText = lists.length > 0
      ? `🎉 ${userMention}, aquí tienes las listas IPTV generadas:\n\n` +
        lists.map(list => `- *${list.type} (${list.category})*: [${escapeMarkdown(list.url)}](${list.url})\n  - Canales: ${list.totalChannels || 'Desconocido'}\n  - Expira: ${list.expiresAt || 'Desconocida'}`).join('\n') +
        `\n\n${adminMessage}`
      : `❌ ${userMention}, no se encontraron listas activas en este momento. Intenta de nuevo más tarde.${adminMessage}`;

    await bot.editMessageText(responseText, {
      chat_id: chatId,
      message_id: loadingMessage.message_id,
      message_thread_id: threadId,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '⬅️ Regresar', callback_data: 'back_to_main' }]
        ]
      }
    });
  } catch (error) {
    logAction('generate_error', { error: error.message });
    await bot.editMessageText(`❌ ${userMention}, error al generar listas: ${error.message}${adminMessage}`, {
      chat_id: chatId,
      message_id: loadingMessage.message_id,
      message_thread_id: threadId,
      parse_mode: 'Markdown',
      ...mainMenu
    });
  }
}

// Función para manejar espejos
async function handleMirror(ctx, chatId, threadId, url, userId, userMention) {
  const loadingMessage = await ctx.reply(`🪞 ${userMention}, verificando ${escapeMarkdown(url)} y buscando espejos...${adminMessage}`, {
    parse_mode: 'Markdown',
    message_thread_id: threadId
  });

  const result = await checkIPTVList(url, userId);
  if (result.status === 'Activa') {
    await bot.editMessageText(`✅ ${userMention}, la lista ${escapeMarkdown(url)} está activa. No se necesita un espejo.${adminMessage}`, {
      chat_id: chatId,
      message_id: loadingMessage.message_id,
      message_thread_id: threadId,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '⬅️ Regresar', callback_data: 'back_to_main' }]
        ]
      }
    });
    return;
  }

  const { data: mirrors, error } = await supabase
    .from('mirrors')
    .select('*')
    .eq('original_url', url)
    .eq('status', 'Active');

  if (!error && mirrors && mirrors.length > 0) {
    await bot.editMessageText(`✅ ${userMention}, la lista original está caída, pero aquí tienes un espejo activo:\n` +
      `[${escapeMarkdown(mirrors[0].mirror_url)}](${mirrors[0].mirror_url})${adminMessage}`, {
      chat_id: chatId,
      message_id: loadingMessage.message_id,
      message_thread_id: threadId,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '⬅️ Regresar', callback_data: 'back_to_main' }]
        ]
      }
    });
    return;
  }

  const mirrorSources = [
    { url: 'https://iptv-org.github.io/iptv/countries/es.m3u', source: 'IPTV-Org España' },
    { url: 'https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8', source: 'Free-TV' },
    { url: 'https://iptvcat.net/static/uploads/iptv_list_66ebeb47eecf0.m3u', source: 'IPTVCat' },
    { url: 'https://m3u.cl/lista.m3u', source: 'M3U.CL' }
  ];

  const urlObj = new URL(url);
  const domain = urlObj.hostname;
  const domainParts = domain.split('.');
  const baseDomain = domainParts.slice(-2).join('.');
  const subDomain = domainParts.length > 2 ? domainParts[0] : '';
  const mirrorCandidates = [
    ...mirrorSources,
    { url: url.replace(domain, `${subDomain || 'mirror'}-backup.${baseDomain}`), source: 'Patrón de subdominio' },
    { url: url.replace(domain, `backup-${baseDomain}`), source: 'Patrón de backup' },
    { url: url.replace(domain, `mirror-${baseDomain}`), source: 'Patrón de mirror' }
  ];

  let activeMirror = null;
  for (const candidate of mirrorCandidates) {
    const mirrorResult = await checkIPTVList(candidate.url, userId);
    if (mirrorResult.status === 'Activa') {
      activeMirror = candidate.url;
      const { error } = await supabase.from('mirrors').insert({
        original_url: url,
        mirror_url: candidate.url,
        status: 'Active',
        last_checked: new Date().toISOString()
      });
      if (error) {
        logAction('insert_mirror_error', { url: candidate.url, error: error.message });
      }
      break;
    }
  }

  const responseText = activeMirror
    ? `✅ ${userMention}, la lista original está caída, pero encontré un espejo activo:\n` +
      `[${escapeMarkdown(activeMirror)}](${activeMirror})${adminMessage}`
    : `❌ ${userMention}, la lista está caída y no se encontraron espejos activos. Intenta con otra lista.${adminMessage}`;

  await bot.editMessageText(responseText, {
    chat_id: chatId,
    message_id: loadingMessage.message_id,
    message_thread_id: threadId,
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '⬅️ Regresar', callback_data: 'back_to_main' }]
      ]
    }
  });
}

// Programar la generación de listas públicas cada 6 horas
cron.schedule('0 */6 * * *', async () => {
  try {
    await generatePublicLists();
  } catch (error) {
    logAction('cron_generate_error', { error: error.message });
  }
});

// Manejo de errores generales
bot.on('polling_error', (error) => {
  logAction('polling_error', { error: error.message });
});

bot.on('webhook_error', (error) => {
  logAction('webhook_error', { error: error.message });
});

// Inicializar el bot
(async () => {
  await restructureDatabase();
  logAction('bot_initialized', { status: 'success' });

  // Iniciar polling
  bot.launch()
    .then(() => console.log('Bot started with polling'))
    .catch(error => console.error('Error starting bot with polling:', error.message));

  await generatePublicLists();

  app.listen(PORT, () => {
    console.log(`🚀 Servidor en puerto ${PORT}`);
  });
})();