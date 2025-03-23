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
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp4cGRpdnRjY25oc3NwdndmcGRsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDI2NDc1MzYsImV4cCI6MjA1ODIyMzUzNn0.oVV31TUxJeCEZZByLb5gsvl9vpme8XZ9XnOKoaZFJKI';
const supabase = createClient(supabaseUrl, supabaseKey);

// IDs permitidos
const ALLOWED_CHAT_IDS = [
  { chatId: '-1002348662107', threadId: '53411', name: 'EntresHijos' },
  { chatId: '-1002565012502', threadId: null, name: 'BotChecker_IPTV_ParaG' }
];

// Almacenar datos en memoria
let userHistory = {};
let userStates = {};
let processedUpdates = new Set();
let publicLists = [];

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

// Animación de porcentaje
async function showPercentageAnimation(chatId, threadId, messageId, baseText, totalSteps) {
  for (let i = 0; i <= totalSteps; i++) {
    const percentage = Math.round((i / totalSteps) * 100);
    const barLength = 10;
    const filled = Math.round((percentage / 100) * barLength);
    const empty = barLength - filled;
    const progressBar = '█'.repeat(filled) + '░'.repeat(empty);
    try {
      await bot.editMessageText(`${baseText}\nProgreso: [${progressBar}] ${percentage}%`, {
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
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

// Configuración de axios para ignorar errores de SSL
const axiosInstance = axios.create({
  timeout: 15000,
  httpsAgent: new (require('https').Agent)({
    rejectUnauthorized: false
  })
});

// Reestructuración automática de la base de datos en Supabase
async function restructureDatabase() {
  const requiredTables = {
    'public_lists': {
      columns: {
        id: 'uuid default uuid_generate_v4() primary key',
        url: 'text not null',
        type: 'text',
        category: 'text',
        status: 'text',
        total_channels: 'integer',
        expires_at: 'text',
        last_checked: 'timestamp with time zone default now()'
      }
    },
    'votes': {
      columns: {
        id: 'uuid default uuid_generate_v4() primary key',
        list_id: 'uuid references public_lists(id)',
        user_id: 'bigint',
        vote_type: 'text',
        created_at: 'timestamp with time zone default now()'
      }
    },
    'mirrors': {
      columns: {
        id: 'uuid default uuid_generate_v4() primary key',
        original_url: 'text not null',
        mirror_url: 'text not null',
        status: 'text default \'Pending\'',
        last_checked: 'timestamp with time zone default now()'
      }
    }
  };

  for (const [tableName, schema] of Object.entries(requiredTables)) {
    try {
      // Verificar si la tabla existe
      const { data, error } = await supabase.rpc('table_exists', { table_name: tableName });
      if (error) throw error;

      if (!data) {
        // Crear la tabla si no existe
        const columnDefs = Object.entries(schema.columns).map(([col, def]) => `${col} ${def}`).join(', ');
        await supabase.rpc('execute_sql', { sql: `CREATE TABLE ${tableName} (${columnDefs});` });
        logAction('table_created', { table: tableName });
      } else {
        // Verificar y corregir columnas
        const { data: columns, error: colError } = await supabase.rpc('get_table_columns', { table_name: tableName });
        if (colError) throw colError;

        const existingColumns = columns.map(col => col.column_name);
        for (const [colName, colDef] of Object.entries(schema.columns)) {
          if (!existingColumns.includes(colName)) {
            await supabase.rpc('execute_sql', { sql: `ALTER TABLE ${tableName} ADD COLUMN ${colName} ${colDef.split(' ').slice(1).join(' ')};` });
            logAction('column_added', { table: tableName, column: colName });
          }
        }
      }
    } catch (error) {
      logAction('database_restructure_error', { table: tableName, error: error.message });
    }
  }
}

// Inicialización del bot
async function initializeBot() {
  await restructureDatabase();
  logAction('bot_initialized', { status: 'success' });
}

// Ruta webhook (para Render)
app.post(`/bot${token}`, (req, res) => {
  const updateId = req.body.update_id;
  if (processedUpdates.has(updateId)) {
    res.sendStatus(200);
    return;
  }
  processedUpdates.add(updateId);
  if (processedUpdates.size > 1000) processedUpdates.clear();
  logAction('webhook_received', { update: req.body });
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.get('/', (req, res) => res.send(`${botName} is running`));

// Iniciar servidor
app.listen(port, async () => {
  console.log(`🚀 Servidor en puerto ${port}`);
  await setWebhookWithRetry();
  await initializeBot();
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

// Verificar lista IPTV
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
    `🚀 *${botName} - Verificación Profesional y Gratuita*${adminMessage}`;

  return { text: response };
}

// Menú principal con botones
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
      await bot.editMessageText(`🔎 ${userMention}, envía un enlace IPTV válido (M3U, Xtream, TS, JSON, XML, etc.): 📡${adminMessage}`, {
        chat_id: chatId,
        message_id: messageId,
        message_thread_id: allowedThreadId,
        parse_mode: 'Markdown'
      });
    } else if (query.data === 'generate') {
      await handleGenerate(chatId, allowedThreadId, messageId, userId, userMention);
    } else if (query.data === 'public_lists') {
      await handlePublicLists(chatId, allowedThreadId, messageId, userId, userMention);
    } else if (query.data === 'mirror') {
      userStates[userId].action = 'mirror';
      await bot.editMessageText(`🪞 ${userMention}, envía la URL de la lista IPTV para buscar un servidor espejo: 📡${adminMessage}`, {
        chat_id: chatId,
        message_id: messageId,
        message_thread_id: allowedThreadId,
        parse_mode: 'Markdown'
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
    await bot.sendMessage(chatId, `❌ ${userMention}, error: ${error.message}${adminMessage}`, {
      message_thread_id: allowedThreadId,
      parse_mode: 'Markdown'
    });
  }
});

// Comando inicial /iptv
bot.onText(/\/iptv/, async (msg) => {
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id || '0';
  const userMention = getUserMention(msg.from);
  const allowedThreadId = getAllowedThreadId(chatId);

  if (!isAllowedContext(chatId, threadId)) return;

  const response = `🌟 ¡Hola ${userMention}! Bienvenido a *${botName}* 🌟\n\n` +
    `✅ Verifica tus listas IPTV de forma gratuita y rápida.\n` +
    `🔧 Usa los botones para navegar por las opciones.\n\n` +
    `👨‍💼 *Equipo de Administración EntresHijos*`;
  await bot.sendMessage(chatId, response, {
    parse_mode: 'Markdown',
    message_thread_id: allowedThreadId,
    ...mainMenu
  });
});

// Comando /espejo
bot.onText(/\/espejo/, async (msg) => {
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id || '0';
  const userId = msg.from.id;
  const userMention = getUserMention(msg.from);
  const allowedThreadId = getAllowedThreadId(chatId);

  if (!isAllowedContext(chatId, threadId)) return;

  userStates[userId] = { action: 'mirror' };
  await bot.sendMessage(chatId, `🪞 ${userMention}, envía la URL de la lista IPTV para buscar un servidor espejo: 📡${adminMessage}`, {
    parse_mode: 'Markdown',
    message_thread_id: allowedThreadId,
    ...mainMenu
  });
});

// Función para manejar /generar con animación
async function handleGenerate(chatId, threadId, messageId, userId, userMention) {
  const loadingMessage = await bot.sendMessage(chatId, `⏳ ${userMention}, buscando listas IPTV de múltiples fuentes...${adminMessage}`, {
    parse_mode: 'Markdown',
    message_thread_id: threadId
  });

  try {
    const staticSources = [
      { url: 'https://iptv-org.github.io/iptv/countries/es.m3u', category: 'España' },
      { url: 'https://iptv-org.github.io/iptv/languages/spa.m3u', category: 'Español' },
      { url: 'https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8', category: 'General' },
      { url: 'https://raw.githubusercontent.com/iptv-org/iptv/master/streams/mx.m3u', category: 'México' }
    ];

    const sourcesToProcess = staticSources.slice(0, 4);
    await showPercentageAnimation(chatId, threadId, loadingMessage.message_id, `⏳ ${userMention}, procesando listas IPTV...`, sourcesToProcess.length);

    const lists = [];
    for (const source of sourcesToProcess) {
      const result = await checkIPTVList(source.url, userId);
      if (result.status === 'Activa') {
        lists.push({
          url: source.url,
          type: source.url.endsWith('.m3u8') ? 'M3U8' : 'M3U',
          category: source.category,
          status: result.status,
          totalChannels: result.totalChannels,
          expiresAt: result.expiresAt
        });
        publicLists.push(source.url);
        if (publicLists.length > 100) publicLists.shift();

        await supabase.from('public_lists').insert({
          url: source.url,
          type: source.url.endsWith('.m3u8') ? 'M3U8' : 'M3U',
          category: source.category,
          status: result.status,
          total_channels: result.totalChannels || 0,
          expires_at: result.expiresAt || 'Desconocida',
          last_checked: new Date().toISOString()
        });
      }
    }

    let responseText = lists.length > 0
      ? `🎉 ${userMention}, aquí tienes las listas IPTV generadas:\n\n` +
        lists.map(list => `- *${list.type} (${list.category})*: [${escapeMarkdown(list.url)}](${list.url})\n  - Canales: ${list.totalChannels || 'Desconocido'}\n  - Expira: ${list.expiresAt || 'Desconocida'}`).join('\n') +
        `\n\n${adminMessage}`
      : `❌ ${userMention}, no se encontraron listas activas en este momento.${adminMessage}`;

    await bot.editMessageText(responseText, {
      chat_id: chatId,
      message_id: loadingMessage.message_id,
      message_thread_id: threadId,
      parse_mode: 'Markdown',
      ...mainMenu
    });
  } catch (error) {
    await bot.editMessageText(`❌ ${userMention}, error al generar listas: ${error.message}${adminMessage}`, {
      chat_id: chatId,
      message_id: loadingMessage.message_id,
      message_thread_id: threadId,
      parse_mode: 'Markdown',
      ...mainMenu
    });
  }
}

// Función para manejar listas públicas
async function handlePublicLists(chatId, threadId, messageId, userId, userMention) {
  const loadingMessage = await bot.sendMessage(chatId, `⏳ ${userMention}, cargando listas públicas...${adminMessage}`, {
    parse_mode: 'Markdown',
    message_thread_id: threadId
  });

  const { data: lists, error } = await supabase
    .from('public_lists')
    .select('*')
    .order('last_checked', { ascending: false })
    .limit(5);

  if (error || !lists || lists.length === 0) {
    await bot.editMessageText(`📚 ${userMention}, no hay listas públicas disponibles en este momento. Usa "Generar Listas" para crear nuevas.${adminMessage}`, {
      chat_id: chatId,
      message_id: loadingMessage.message_id,
      message_thread_id: threadId,
      parse_mode: 'Markdown',
      ...mainMenu
    });
    return;
  }

  await showPercentageAnimation(chatId, threadId, loadingMessage.message_id, `⏳ ${userMention}, procesando listas públicas...`, lists.length);

  let responseText = `📚 *Listas públicas más recientes*:\n\n`;
  const keyboard = [];
  for (const list of lists) {
    const { data: votes } = await supabase
      .from('votes')
      .select('vote_type')
      .eq('list_id', list.id);

    const upvotes = votes.filter(v => v.vote_type === 'upvote').length;
    const downvotes = votes.filter(v => v.vote_type === 'downvote').length;

    responseText += `- *${list.type} (${list.category})*: [${escapeMarkdown(list.url)}](${list.url})\n` +
      `  - Estado: ${list.status}\n` +
      `  - Canales: ${list.total_channels || 'Desconocido'}\n` +
      `  - Expira: ${list.expires_at || 'Desconocida'}\n` +
      `  - 👍 ${upvotes} | 👎 ${downvotes}\n\n`;
    keyboard.push([
      { text: `👍 Me gusta (${upvotes})`, callback_data: `vote_upvote_${list.id}` },
      { text: `👎 No funciona (${downvotes})`, callback_data: `vote_downvote_${list.id}` }
    ]);
  }
  responseText += adminMessage;

  await bot.editMessageText(responseText, {
    chat_id: chatId,
    message_id: loadingMessage.message_id,
    message_thread_id: threadId,
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
}

// Procesar URLs IPTV
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id || '0';
  const userId = msg.from.id;
  const text = msg.text || '';
  const userMention = getUserMention(msg.from);
  const allowedThreadId = getAllowedThreadId(chatId);

  if (!isAllowedContext(chatId, threadId) || text.startsWith('/')) return;

  if (!userStates[userId]) userStates[userId] = {};

  const urlMatch = text.match(/(http|https):\/\/[^\s]+/);
  if (urlMatch && (userStates[userId].action === 'check' || userStates[userId].action === 'mirror')) {
    const url = urlMatch[0];

    if (!isValidIPTVFormat(url)) {
      await bot.sendMessage(chatId, `❌ ${userMention}, formato no válido. Usa un enlace IPTV soportado (M3U, Xtream, etc.).${adminMessage}`, {
        parse_mode: 'Markdown',
        message_thread_id: allowedThreadId,
        ...mainMenu
      });
      return;
    }

    if (userStates[userId].action === 'check') {
      const checkingMessage = await bot.sendMessage(chatId, `🔎 ${userMention}, verificando ${escapeMarkdown(url)}...${adminMessage}`, {
        parse_mode: 'Markdown',
        message_thread_id: allowedThreadId
      });

      const result = await checkIPTVList(url, userId);
      userHistory[userId] = userHistory[userId] || [];
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
    } else if (userStates[userId].action === 'mirror') {
      await handleMirror(chatId, allowedThreadId, url, userId, userMention);
    }

    userStates[userId].action = null;
  }
});

// Función para manejar espejos
async function handleMirror(chatId, threadId, url, userId, userMention) {
  const loadingMessage = await bot.sendMessage(chatId, `🪞 ${userMention}, verificando ${escapeMarkdown(url)} y buscando espejos...${adminMessage}`, {
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
      ...mainMenu
    });
    return;
  }

  const { data: mirrors, error } = await supabase
    .from('mirrors')
    .select('*')
    .eq('original_url', url)
    .eq('status', 'Active');

  if (error || !mirrors || mirrors.length === 0) {
    // Buscar espejos simulados (esto podría expandirse con una API real)
    const mirrorCandidates = [
      url.replace('server.com', 'mirror1.com'),
      url.replace('server.com', 'mirror2.com')
    ];

    await showPercentageAnimation(chatId, threadId, loadingMessage.message_id, `🪞 ${userMention}, buscando servidores espejo...`, mirrorCandidates.length);

    let activeMirror = null;
    for (const candidate of mirrorCandidates) {
      const mirrorResult = await checkIPTVList(candidate, userId);
      if (mirrorResult.status === 'Activa') {
        activeMirror = candidate;
        await supabase.from('mirrors').insert({
          original_url: url,
          mirror_url: candidate,
          status: 'Active',
          last_checked: new Date().toISOString()
        });
        break;
      }
    }

    const responseText = activeMirror
      ? `✅ ${userMention}, la lista original está caída, pero encontré un espejo activo:\n` +
        `[${escapeMarkdown(activeMirror)}](${activeMirror})${adminMessage}`
      : `❌ ${userMention}, la lista está caída y no se encontraron espejos activos.${adminMessage}`;

    await bot.editMessageText(responseText, {
      chat_id: chatId,
      message_id: loadingMessage.message_id,
      message_thread_id: threadId,
      parse_mode: 'Markdown',
      ...mainMenu
    });
  } else {
    await bot.editMessageText(`✅ ${userMention}, la lista original está caída, pero aquí tienes un espejo activo:\n` +
      `[${escapeMarkdown(mirrors[0].mirror_url)}](${mirrors[0].mirror_url})${adminMessage}`, {
      chat_id: chatId,
      message_id: loadingMessage.message_id,
      message_thread_id: threadId,
      parse_mode: 'Markdown',
      ...mainMenu
    });
  }
}

// Verificación programada de espejos (cada 6 horas)
cron.schedule('0 */6 * * *', async () => {
  const { data: mirrors } = await supabase.from('mirrors').select('*');
  if (!mirrors) return;

  for (const mirror of mirrors) {
    const result = await checkIPTVList(mirror.mirror_url, 'cron');
    await supabase
      .from('mirrors')
      .update({ status: result.status === 'Activa' ? 'Active' : 'Inactive', last_checked: new Date().toISOString() })
      .eq('id', mirror.id);

    if (result.status !== 'Activa') {
      const chatId = ALLOWED_CHAT_IDS[0].chatId;
      const threadId = getAllowedThreadId(chatId);
      await bot.sendMessage(chatId, `📢 El espejo ${escapeMarkdown(mirror.mirror_url)} para ${escapeMarkdown(mirror.original_url)} está inactivo.${adminMessage}`, {
        parse_mode: 'Markdown',
        message_thread_id: threadId
      });
    }
  }
}, { scheduled: true, timezone: 'Europe/Madrid' });

// Generar listas públicas cada 24 horas
cron.schedule('0 12 * * *', async () => {
  const chatId = ALLOWED_CHAT_IDS[0].chatId;
  const threadId = getAllowedThreadId(chatId);
  await bot.sendMessage(chatId, `⏳ Generando nuevas listas públicas...${adminMessage}`, {
    parse_mode: 'Markdown',
    message_thread_id: threadId
  });

  const staticSources = [
    { url: 'https://iptv-org.github.io/iptv/countries/es.m3u', category: 'España' },
    { url: 'https://iptv-org.github.io/iptv/languages/spa.m3u', category: 'Español' },
    { url: 'https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8', category: 'General' }
  ];

  for (const source of staticSources) {
    const result = await checkIPTVList(source.url, 'cron');
    if (result.status === 'Activa') {
      await supabase.from('public_lists').insert({
        url: source.url,
        type: source.url.endsWith('.m3u8') ? 'M3U8' : 'M3U',
        category: source.category,
        status: result.status,
        total_channels: result.totalChannels || 0,
        expires_at: result.expiresAt || 'Desconocida',
        last_checked: new Date().toISOString()
      });
    }
  }

  await bot.sendMessage(chatId, `✅ Nuevas listas públicas generadas.${adminMessage}`, {
    parse_mode: 'Markdown',
    message_thread_id: threadId
  });
}, { scheduled: true, timezone: 'Europe/Madrid' });

// Mantener servidor activo (para UptimeRobot)
setInterval(() => {
  axios.get('https://entrelinks.onrender.com')
    .then(() => logAction('keep_alive', { status: 'success' }))
    .catch(error => logAction('keep_alive_error', { error: error.message }));
}, 5 * 60 * 1000);

console.log(`🚀 ${botName} iniciado correctamente`);

module.exports = bot;