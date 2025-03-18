const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');

// Token y Chat ID desde variables de entorno
const token = process.env.TOKEN || '7861676131:AAEIAjkMYnQPN858UPpJAG2bX5Wmxk6UFEg';
const bot = new TelegramBot(token);

// Configuración del servidor Express
const app = express();
const port = process.env.PORT || 10000;
const adminGroupChatId = process.env.GROUP_DESTINO || '-1002516061331';

// Almacenamiento en memoria
let links = [];
let linkViews = new Map();
let userStats = new Map();
let blockedUsers = new Set();
let maxLinksBeforeAlert = process.env.MAX_LINKS_BEFORE_ALERT || 10;

// Middleware para parsear JSON
app.use(express.json());

// Ruta para el webhook
app.post(`/bot${token}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Ruta para redirección de enlaces únicos
app.get('/link/:id', async (req, res) => {
  const linkId = req.params.id;
  const userId = req.query.user_id;
  const userIp = req.ip || req.headers['x-forwarded-for'] || 'Desconocida';
  if (blockedUsers.has(parseInt(userId))) {
    console.log(`❌ Acceso denegado para usuario bloqueado ${userId} al enlace ${linkId}`);
    return res.status(403).send('🚫 Acceso denegado: Estás bloqueado.');
  }
  const link = links.find(l => l.uniqueId === linkId);
  if (!link) {
    console.log(`❌ Enlace único ${linkId} no encontrado`);
    return res.status(404).send('⚠️ Enlace no encontrado');
  }
  if (Date.now() > link.expirationTime) {
    console.log(`❌ Enlace único ${linkId} ha expirado`);
    return res.status(410).send('⚠️ Enlace ha expirado');
  }
  const views = linkViews.get(link.number) || [];
  if (link.restricted && views.some(v => v.userId === userId)) {
    console.log(`❌ Enlace #${link.number} restringido, usuario ${userId} ya lo usó`);
    return res.status(403).send('🚫 Este enlace solo puede usarse una vez por usuario.');
  }
  if (link.maxViews && views.length >= link.maxViews) {
    console.log(`❌ Enlace #${link.number} alcanzó límite de ${link.maxViews} vistas`);
    links = links.filter(l => l.uniqueId !== linkId); // Revocar enlace
    return res.status(410).send('⚠️ Enlace revocado por límite de vistas.');
  }
  console.log(`🔗 Redirigiendo enlace único ${linkId} a ${link.original}`);
  res.redirect(link.original);

  let username = `Usuario_${userId}`;
  try {
    const user = await bot.getChat(userId);
    username = user.username ? `@${user.username}` : `${user.first_name || ''} ${user.last_name || ''}`.trim() || `Usuario_${userId}`;
  } catch (error) {
    console.error(`❌ Error al obtener info de usuario ${userId}: ${error.message}`);
  }

  if (!linkViews.has(link.number)) linkViews.set(link.number, []);
  const updatedViews = linkViews.get(link.number);
  if (!updatedViews.some(v => v.userId === userId && v.userIp === userIp)) {
    updatedViews.push({
      userId,
      username,
      timestamp: Date.now(),
      chatId: null,
      action: 'accedió',
      userIp,
    });
    linkViews.set(link.number, updatedViews);
    console.log(`👤 ${username} (${userId}) accedió al enlace #${link.number} desde IP ${userIp}`);
  }
});

// Iniciar el servidor
app.listen(port, () => {
  console.log(`🚀 Servidor escuchando en el puerto ${port}`);
  const webhookUrl = process.env.WEBHOOK_URL || `https://entrelinks.onrender.com/bot${token}`;
  bot.setWebHook(webhookUrl)
    .then(() => console.log(`✅ Webhook configurado: ${webhookUrl}`))
    .catch(err => console.error(`❌ Error al configurar webhook: ${err.message}`));
});

// Utilidades
function generateUniqueId() {
  return crypto.randomBytes(8).toString('hex');
}

async function validateUrl(url) {
  try {
    const response = await axios.get(url, {
      timeout: 10000,
      maxRedirects: 5,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      },
    });
    console.log(`✅ Enlace validado: ${url} (Status: ${response.status})`);
    return true;
  } catch (error) {
    if (error.response?.status === 403) {
      console.log(`⚠️ Enlace ${url} devolvió 403, considerado válido`);
      return true;
    }
    console.error(`❌ Error al validar enlace ${url}: ${error.message}`);
    return false;
  }
}

function extractUrl(message) {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const text = message.text || message.caption || '';
  return text.match(urlRegex) || null;
}

function generateUniqueLink(originalUrl, linkNumber) {
  const uniqueId = generateUniqueId();
  const expirationTime = Date.now() + 24 * 60 * 60 * 1000;
  const baseUrl = process.env.WEBHOOK_URL || 'https://entrelinks.onrender.com';
  return {
    uniqueId,
    uniqueUrl: `${baseUrl}/link/${uniqueId}`,
    displayUrl: `https://entreshijoslink-${linkNumber}`,
    expirationTime,
    restricted: false,
    maxViews: null,
  };
}

// Generación de enlaces
bot.on('message', async (msg) => {
  const chatId = msg.chat.id.toString();
  if (chatId !== adminGroupChatId) return;

  if (msg.text && msg.text.startsWith('/')) return;

  try {
    console.log(`📩 Mensaje recibido en ${chatId}:`, {
      text: msg.text,
      caption: msg.caption,
      hasPhoto: !!msg.photo,
      hasVideo: !!msg.video,
      hasDocument: !!msg.document,
    });

    const urls = extractUrl(msg);
    if (!urls) return;

    console.log(`🔗 Enlaces detectados: ${urls.join(', ')}`);
    let modifiedText = msg.text || msg.caption || '';
    let linkNumber = links.length + 1;

    for (const url of urls) {
      if (!(await validateUrl(url))) {
        console.log(`⛔ Enlace inválido, omitiendo: ${url}`);
        continue;
      }

      const { uniqueId, uniqueUrl, displayUrl } = generateUniqueLink(url, linkNumber);
      console.log(`🔧 ${url} -> ${uniqueUrl}`);
      links.push({
        original: url,
        unique: uniqueUrl,
        display: displayUrl,
        uniqueId,
        number: linkNumber,
        messageId: msg.message_id,
      });
      modifiedText = modifiedText.replace(url, `[${displayUrl}](${uniqueUrl}?user_id=${msg.from.id})`);
      linkNumber++;
    }

    if (modifiedText !== (msg.text || msg.caption || '')) {
      await bot.sendMessage(chatId, modifiedText, {
        reply_to_message_id: msg.message_id,
        parse_mode: 'Markdown',
      });
    }
  } catch (error) {
    console.error('❌ Error al procesar mensaje:', error.message);
    await bot.sendMessage(chatId, '⚠️ Error al procesar el mensaje.');
  }
});

// Registro de interacciones
bot.on('message', async (msg) => {
  const chatId = msg.chat.id.toString();
  const userId = msg.from.id;
  const username = msg.from.username ? `@${msg.from.username}` : `Usuario_${userId}`;
  const isForward = !!msg.forward_date;

  if (msg.text && msg.text.startsWith('/')) return;

  try {
    const admins = await bot.getChatAdministrators(adminGroupChatId);
    if (admins.some(admin => admin.user.id === userId)) return;

    const text = msg.text || msg.caption || '';
    const link = links.find(l => text.includes(l.display));
    if (!link) return;

    const linkNumber = link.number;
    const action = isForward ? 'reenvió' : 'vio/copió';
    console.log(`👤 ${username} ${action} enlace #${linkNumber} en ${chatId}`);

    if (!linkViews.has(linkNumber)) linkViews.set(linkNumber, []);
    const views = linkViews.get(linkNumber);
    if (!views.some(v => v.userId === userId)) {
      views.push({
        userId,
        username,
        timestamp: Date.now(),
        chatId,
        action,
      });
      linkViews.set(linkNumber, views);

      const userStat = userStats.get(userId) || { username, count: 0 };
      userStat.count += 1;
      userStats.set(userId, userStat);

      if (userStat.count > maxLinksBeforeAlert) {
        await bot.sendMessage(adminGroupChatId, 
          `⚠️ ${username} ha interactuado con más de ${maxLinksBeforeAlert} enlaces.`);
      }
    }
  } catch (error) {
    console.error('❌ Error al registrar interacción:', error.message);
  }
});

// Comandos
bot.onText(/\/menu/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  try {
    const admins = await bot.getChatAdministrators(adminGroupChatId);
    const isAdmin = admins.some(admin => admin.user.id === userId);

    let menuText = '*📋 Menú del Bot EntreHijos*\n\n' +
      '*Comandos para Todos*\n' +
      '🚨 */report <número>* - Reporta un enlace que no funciona\n' +
      'ℹ️ */ayuda* - Explicación de cómo reportar enlaces\n';

    if (isAdmin && chatId.toString() === adminGroupChatId) {
      menuText += '\n*Comandos para Administradores*\n' +
        '🔍 */visto <número>* - Muestra quién interactuó con un enlace\n' +
        '📈 */estadistica* - Top 10 usuarios por interacciones\n' +
        '🚦 */status* - Estado actual del bot\n' +
        '🚫 */revoke <número>* - Revoca un enlace activo\n' +
        '⚠️ */alert <número>* - Alerta sobre un enlace a admins\n' +
        '🔗 */list_links* - Lista todos los enlaces generados\n' +
        '⏳ */extend_link <número> <horas>* - Extiende la duración de un enlace\n' +
        '📝 */generate_report* - Reporte detallado de enlaces\n' +
        '🧹 */clear_stats* - Borra estadísticas de usuarios\n' +
        '⚙️ */set_max_links <número>* - Define límite de interacciones antes de alerta\n' +
        '👀 */total_views* - Total de vistas de todos los enlaces\n' +
        '🔝 */top_links* - Top 5 enlaces más visitados\n' +
        '📜 */link_history <ID>* - Historial de enlaces de un usuario\n' +
        '⏰ */expire_soon* - Enlaces que expiran en 24 horas\n' +
        '🚫 */block_user <ID>* - Bloquea a un usuario\n' +
        '✅ */unblock_user <ID>* - Desbloquea a un usuario\n' +
        '🌐 */check_ip <número>* - IPs que accedieron a un enlace\n' +
        '🔒 */restrict_link <número>* - Limita un enlace a un uso por usuario\n' +
        '⏰ */set_expiration <número> <horas>* - Establece nueva duración de un enlace\n' +
        '📊 */link_usage <número>* - Estadísticas detalladas de un enlace\n' +
        '🚫 */auto_revoke <número> <vistas>* - Revoca tras X vistas';
    }

    if (menuText.length > 4096) {
      const parts = menuText.match(/(.|[\r\n]){1,4096}/g);
      for (const part of parts) {
        await bot.sendMessage(chatId, part, { parse_mode: 'Markdown' });
      }
    } else {
      await bot.sendMessage(chatId, menuText, { parse_mode: 'Markdown' });
    }
  } catch (error) {
    console.error('❌ Error en /menu:', error.message);
    await bot.sendMessage(chatId, '⚠️ Error al mostrar el menú.');
  }
});

bot.onText(/\/ayuda/, (msg) => {
  const chatId = msg.chat.id;
  const helpText = '*ℹ️ Ayuda del Bot EntreHijos*\n\n' +
    'Para reportar un enlace que no funciona, usa el comando:\n' +
    '`/report <número>`\n\n' +
    '*Ejemplo:*\n' +
    'Si el enlace #5 no funciona, escribe:\n' +
    '`/report 5`\n' +
    'Esto notificará a los administradores para que lo revisen.';
  bot.sendMessage(chatId, helpText, { parse_mode: 'Markdown' });
});

bot.onText(/\/report (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const linkNumber = parseInt(match[1]);
  const link = links.find(l => l.number === linkNumber);
  if (!link) {
    return bot.sendMessage(chatId, '⚠️ Enlace no encontrado.');
  }
  await bot.sendMessage(adminGroupChatId, 
    `🚨 Reporte: El enlace #${linkNumber} (${link.display}) fue reportado como no funcional por @${msg.from.username || 'Usuario_' + msg.from.id}`);
  bot.sendMessage(chatId, '✅ Reporte enviado a los administradores.');
});

bot.onText(/\/visto (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const linkNumber = parseInt(match[1]);
  const userId = msg.from.id;

  try {
    const admins = await bot.getChatAdministrators(adminGroupChatId);
    if (!admins.some(admin => admin.user.id === userId)) {
      return bot.sendMessage(chatId, '🚫 Solo admins pueden usar este comando.');
    }
    const link = links.find(l => l.number === linkNumber);
    if (!link) {
      return bot.sendMessage(chatId, '⚠️ Enlace no encontrado.');
    }
    const views = linkViews.get(linkNumber) || [];
    if (views.length === 0) {
      return bot.sendMessage(chatId, 'ℹ️ Sin interacciones.');
    }

    const viewList = views.map((v, index) => {
      const date = new Date(v.timestamp).toLocaleString();
      return `${index + 1}. ${v.username} (${v.userId}) - Enlace #${linkNumber} - ${date} - Grupo: ${v.chatId || 'Desconocido'}`;
    }).join('\n');

    await bot.sendMessage(chatId, 
      `*Interacciones del enlace #${linkNumber}*\n${viewList}`, 
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    console.error('❌ Error en /visto:', error.message);
    await bot.sendMessage(chatId, '⚠️ Error al procesar /visto.');
  }
});

bot.onText(/\/estadistica/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  try {
    const admins = await bot.getChatAdministrators(adminGroupChatId);
    if (!admins.some(admin => admin.user.id === userId)) {
      return bot.sendMessage(chatId, '🚫 Solo admins pueden usar este comando.');
    }
    if (userStats.size === 0) {
      return bot.sendMessage(chatId, 'ℹ️ Sin estadísticas.');
    }
    const sortedStats = Array.from(userStats.entries())
      .map(([id, stat]) => ({ id, ...stat }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
    const statsText = sortedStats.map((stat, i) => `${i + 1}. ${stat.username} - ${stat.count} interacciones`).join('\n');
    await bot.sendMessage(chatId, `*Estadísticas Top 10*\n${statsText}`, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('❌ Error en /estadistica:', error.message);
    await bot.sendMessage(chatId, '⚠️ Error al procesar /estadistica.');
  }
});

bot.onText(/\/status/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  try {
    const admins = await bot.getChatAdministrators(adminGroupChatId);
    if (!admins.some(admin => admin.user.id === userId)) {
      return bot.sendMessage(chatId, '🚫 Solo admins pueden usar este comando.');
    }
    const statusText = `*Estado del Bot EntreHijos*\n` +
      `Enlaces generados: ${links.length}\n` +
      `Usuarios activos: ${userStats.size}\n` +
      `Bot operativo en puerto: ${port}`;
    await bot.sendMessage(chatId, statusText, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('❌ Error en /status:', error.message);
    await bot.sendMessage(chatId, '⚠️ Error al procesar /status.');
  }
});

bot.onText(/\/revoke (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const linkNumber = parseInt(match[1]);
  const userId = msg.from.id;

  try {
    const admins = await bot.getChatAdministrators(adminGroupChatId);
    if (!admins.some(admin => admin.user.id === userId)) {
      return bot.sendMessage(chatId, '🚫 Solo admins pueden usar este comando.');
    }
    const linkIndex = links.findIndex(l => l.number === linkNumber);
    if (linkIndex === -1) {
      return bot.sendMessage(chatId, '⚠️ Enlace no encontrado.');
    }
    links.splice(linkIndex, 1);
    await bot.sendMessage(chatId, `✅ Enlace #${linkNumber} revocado.`);
  } catch (error) {
    console.error('❌ Error en /revoke:', error.message);
    await bot.sendMessage(chatId, '⚠️ Error al procesar /revoke.');
  }
});

bot.onText(/\/alert (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const linkNumber = parseInt(match[1]);
  const userId = msg.from.id;

  try {
    const admins = await bot.getChatAdministrators(adminGroupChatId);
    if (!admins.some(admin => admin.user.id === userId)) {
      return bot.sendMessage(chatId, '🚫 Solo admins pueden usar este comando.');
    }
    const link = links.find(l => l.number === linkNumber);
    if (!link) {
      return bot.sendMessage(chatId, '⚠️ Enlace no encontrado.');
    }
    const alertMessage = `*⚠️ Alerta*: Posible uso indebido del enlace #${linkNumber} (${link.display}).`;
    await bot.sendMessage(chatId, alertMessage, { parse_mode: 'Markdown' });
    for (const admin of admins) {
      await bot.sendMessage(admin.user.id, alertMessage, { parse_mode: 'Markdown' });
    }
    await bot.sendMessage(chatId, '✅ Alerta enviada a admins.');
  } catch (error) {
    console.error('❌ Error en /alert:', error.message);
    await bot.sendMessage(chatId, '⚠️ Error al procesar /alert.');
  }
});

bot.onText(/\/list_links/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  try {
    const admins = await bot.getChatAdministrators(adminGroupChatId);
    if (!admins.some(admin => admin.user.id === userId)) {
      return bot.sendMessage(chatId, '🚫 Solo admins pueden usar este comando.');
    }
    if (links.length === 0) {
      return bot.sendMessage(chatId, 'ℹ️ No hay enlaces generados.');
    }
    const linkList = links.map(l => 
      `#${l.number}: ${l.display} (Expira: ${new Date(l.expirationTime).toLocaleString()})`
    ).join('\n');
    await bot.sendMessage(chatId, `*🔗 Lista de Enlaces*\n${linkList}`, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('❌ Error en /list_links:', error.message);
    await bot.sendMessage(chatId, '⚠️ Error al procesar /list_links.');
  }
});

bot.onText(/\/extend_link (\d+) (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const linkNumber = parseInt(match[1]);
  const hours = parseInt(match[2]);
  const userId = msg.from.id;

  try {
    const admins = await bot.getChatAdministrators(adminGroupChatId);
    if (!admins.some(admin => admin.user.id === userId)) {
      return bot.sendMessage(chatId, '🚫 Solo admins pueden usar este comando.');
    }
    const link = links.find(l => l.number === linkNumber);
    if (!link) {
      return bot.sendMessage(chatId, '⚠️ Enlace no encontrado.');
    }
    link.expirationTime += hours * 60 * 60 * 1000;
    await bot.sendMessage(chatId, 
      `⏳ Enlace #${linkNumber} extendido por ${hours} horas. Nueva expiración: ${new Date(link.expirationTime).toLocaleString()}`);
  } catch (error) {
    console.error('❌ Error en /extend_link:', error.message);
    await bot.sendMessage(chatId, '⚠️ Error al procesar /extend_link.');
  }
});

bot.onText(/\/generate_report/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  try {
    const admins = await bot.getChatAdministrators(adminGroupChatId);
    if (!admins.some(admin => admin.user.id === userId)) {
      return bot.sendMessage(chatId, '🚫 Solo admins pueden usar este comando.');
    }
    if (links.length === 0) {
      return bot.sendMessage(chatId, 'ℹ️ No hay datos para generar un reporte.');
    }
    const report = links.map(l => {
      const views = linkViews.get(l.number) || [];
      return `#${l.number}: ${l.display} - ${views.length} interacciones`;
    }).join('\n');
    await bot.sendMessage(chatId, `*📝 Reporte Detallado*\n${report}`, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('❌ Error en /generate_report:', error.message);
    await bot.sendMessage(chatId, '⚠️ Error al procesar /generate_report.');
  }
});

bot.onText(/\/clear_stats/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  try {
    const admins = await bot.getChatAdministrators(adminGroupChatId);
    if (!admins.some(admin => admin.user.id === userId)) {
      return bot.sendMessage(chatId, '🚫 Solo admins pueden usar este comando.');
    }
    userStats.clear();
    linkViews.clear();
    await bot.sendMessage(chatId, '🧹 Estadísticas limpiadas exitosamente.');
  } catch (error) {
    console.error('❌ Error en /clear_stats:', error.message);
    await bot.sendMessage(chatId, '⚠️ Error al procesar /clear_stats.');
  }
});

bot.onText(/\/set_max_links (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const newMax = parseInt(match[1]);

  try {
    const admins = await bot.getChatAdministrators(adminGroupChatId);
    if (!admins.some(admin => admin.user.id === userId)) {
      return bot.sendMessage(chatId, '🚫 Solo admins pueden usar este comando.');
    }
    maxLinksBeforeAlert = newMax;
    await bot.sendMessage(chatId, `⚙️ Límite de enlaces antes de alerta establecido a ${newMax}.`);
  } catch (error) {
    console.error('❌ Error en /set_max_links:', error.message);
    await bot.sendMessage(chatId, '⚠️ Error al procesar /set_max_links.');
  }
});

bot.onText(/\/total_views/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  try {
    const admins = await bot.getChatAdministrators(adminGroupChatId);
    if (!admins.some(admin => admin.user.id === userId)) {
      return bot.sendMessage(chatId, '🚫 Solo admins pueden usar este comando.');
    }
    const totalViews = Array.from(linkViews.values()).reduce((sum, views) => sum + views.length, 0);
    await bot.sendMessage(chatId, 
      `*📊 Total de Interacciones*\nVistas totales: ${totalViews}`, 
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    console.error('❌ Error en /total_views:', error.message);
    await bot.sendMessage(chatId, '⚠️ Error al procesar /total_views.');
  }
});

bot.onText(/\/ping/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  try {
    const admins = await bot.getChatAdministrators(adminGroupChatId);
    if (!admins.some(admin => admin.user.id === userId)) {
      return bot.sendMessage(chatId, '🚫 Solo admins pueden usar este comando.');
    }
    bot.sendMessage(chatId, '🏓 ¡Pong! El bot está en línea.');
  } catch (error) {
    console.error('❌ Error en /ping:', error.message);
    await bot.sendMessage(chatId, '⚠️ Error al procesar /ping.');
  }
});

bot.onText(/\/top_links/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  try {
    const admins = await bot.getChatAdministrators(adminGroupChatId);
    if (!admins.some(admin => admin.user.id === userId)) {
      return bot.sendMessage(chatId, '🚫 Solo admins pueden usar este comando.');
    }
    const topLinks = links
      .map(l => ({ number: l.number, display: l.display, views: (linkViews.get(l.number) || []).length }))
      .sort((a, b) => b.views - a.views)
      .slice(0, 5);
    if (topLinks.length === 0) {
      return bot.sendMessage(chatId, 'ℹ️ No hay enlaces con interacciones.');
    }
    const topList = topLinks.map((l, i) => `${i + 1}. #${l.number} (${l.display}) - ${l.views} vistas`).join('\n');
    await bot.sendMessage(chatId, `*🔝 Top 5 Enlaces Más Visitados*\n${topList}`, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('❌ Error en /top_links:', error.message);
    await bot.sendMessage(chatId, '⚠️ Error al procesar /top_links.');
  }
});

bot.onText(/\/link_history (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const targetUserId = parseInt(match[1]);

  try {
    const admins = await bot.getChatAdministrators(adminGroupChatId);
    if (!admins.some(admin => admin.user.id === userId)) {
      return bot.sendMessage(chatId, '🚫 Solo admins pueden usar este comando.');
    }
    const userViews = Array.from(linkViews.entries())
      .flatMap(([linkNumber, views]) => 
        views.filter(v => v.userId === targetUserId).map(v => ({ linkNumber, ...v }))
      );
    if (userViews.length === 0) {
      return bot.sendMessage(chatId, 'ℹ️ Este usuario no ha interactuado con ningún enlace.');
    }
    const history = userViews.map((v, i) => 
      `${i + 1}. ${v.username} - Enlace #${v.linkNumber} - ${new Date(v.timestamp).toLocaleString()}`
    ).join('\n');
    await bot.sendMessage(chatId, `*📜 Historial de ${userViews[0].username}*\n${history}`, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('❌ Error en /link_history:', error.message);
    await bot.sendMessage(chatId, '⚠️ Error al procesar /link_history.');
  }
});

bot.onText(/\/expire_soon/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  try {
    const admins = await bot.getChatAdministrators(adminGroupChatId);
    if (!admins.some(admin => admin.user.id === userId)) {
      return bot.sendMessage(chatId, '🚫 Solo admins pueden usar este comando.');
    }
    const soonExpiring = links.filter(l => {
      const timeLeft = l.expirationTime - Date.now();
      return timeLeft > 0 && timeLeft <= 24 * 60 * 60 * 1000;
    });
    if (soonExpiring.length === 0) {
      return bot.sendMessage(chatId, 'ℹ️ No hay enlaces que expiren pronto.');
    }
    const list = soonExpiring.map(l => 
      `#${l.number}: ${l.display} (Expira: ${new Date(l.expirationTime).toLocaleString()})`
    ).join('\n');
    await bot.sendMessage(chatId, `*⏰ Enlaces por Expirar (24h)*\n${list}`, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('❌ Error en /expire_soon:', error.message);
    await bot.sendMessage(chatId, '⚠️ Error al procesar /expire_soon.');
  }
});

bot.onText(/\/block_user (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const targetUserId = parseInt(match[1]);

  try {
    const admins = await bot.getChatAdministrators(adminGroupChatId);
    if (!admins.some(admin => admin.user.id === userId)) {
      return bot.sendMessage(chatId, '🚫 Solo admins pueden usar este comando.');
    }
    blockedUsers.add(targetUserId);
    await bot.sendMessage(chatId, `✅ Usuario ${targetUserId} bloqueado. No podrá acceder a los enlaces.`);
  } catch (error) {
    console.error('❌ Error en /block_user:', error.message);
    await bot.sendMessage(chatId, '⚠️ Error al procesar /block_user.');
  }
});

bot.onText(/\/unblock_user (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const targetUserId = parseInt(match[1]);

  try {
    const admins = await bot.getChatAdministrators(adminGroupChatId);
    if (!admins.some(admin => admin.user.id === userId)) {
      return bot.sendMessage(chatId, '🚫 Solo admins pueden usar este comando.');
    }
    if (blockedUsers.delete(targetUserId)) {
      await bot.sendMessage(chatId, `✅ Usuario ${targetUserId} desbloqueado.`);
    } else {
      await bot.sendMessage(chatId, `ℹ️ El usuario ${targetUserId} no estaba bloqueado.`);
    }
  } catch (error) {
    console.error('❌ Error en /unblock_user:', error.message);
    await bot.sendMessage(chatId, '⚠️ Error al procesar /unblock_user.');
  }
});

bot.onText(/\/check_ip (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const linkNumber = parseInt(match[1]);
  const userId = msg.from.id;

  try {
    const admins = await bot.getChatAdministrators(adminGroupChatId);
    if (!admins.some(admin => admin.user.id === userId)) {
      return bot.sendMessage(chatId, '🚫 Solo admins pueden usar este comando.');
    }
    const link = links.find(l => l.number === linkNumber);
    if (!link) {
      return bot.sendMessage(chatId, '⚠️ Enlace no encontrado.');
    }
    const views = linkViews.get(linkNumber) || [];
    if (views.length === 0) {
      return bot.sendMessage(chatId, 'ℹ️ Sin interacciones.');
    }
    const ipList = views.map((v, i) => 
      `${i + 1}. ${v.username} (${v.userId}) - IP: ${v.userIp || 'Desconocida'} - ${new Date(v.timestamp).toLocaleString()}`
    ).join('\n');
    await bot.sendMessage(chatId, `*🌐 IPs del Enlace #${linkNumber}*\n${ipList}`, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('❌ Error en /check_ip:', error.message);
    await bot.sendMessage(chatId, '⚠️ Error al procesar /check_ip.');
  }
});

bot.onText(/\/restrict_link (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const linkNumber = parseInt(match[1]);
  const userId = msg.from.id;

  try {
    const admins = await bot.getChatAdministrators(adminGroupChatId);
    if (!admins.some(admin => admin.user.id === userId)) {
      return bot.sendMessage(chatId, '🚫 Solo admins pueden usar este comando.');
    }
    const link = links.find(l => l.number === linkNumber);
    if (!link) {
      return bot.sendMessage(chatId, '⚠️ Enlace no encontrado.');
    }
    link.restricted = true;
    await bot.sendMessage(chatId, `🔒 Enlace #${linkNumber} restringido a un uso por usuario.`);
  } catch (error) {
    console.error('❌ Error en /restrict_link:', error.message);
    await bot.sendMessage(chatId, '⚠️ Error al procesar /restrict_link.');
  }
});

bot.onText(/\/set_expiration (\d+) (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const linkNumber = parseInt(match[1]);
  const hours = parseInt(match[2]);
  const userId = msg.from.id;

  try {
    const admins = await bot.getChatAdministrators(adminGroupChatId);
    if (!admins.some(admin => admin.user.id === userId)) {
      return bot.sendMessage(chatId, '🚫 Solo admins pueden usar este comando.');
    }
    const link = links.find(l => l.number === linkNumber);
    if (!link) {
      return bot.sendMessage(chatId, '⚠️ Enlace no encontrado.');
    }
    link.expirationTime = Date.now() + hours * 60 * 60 * 1000;
    await bot.sendMessage(chatId, 
      `⏰ Enlace #${linkNumber} ahora expira en ${hours} horas: ${new Date(link.expirationTime).toLocaleString()}`);
  } catch (error) {
    console.error('❌ Error en /set_expiration:', error.message);
    await bot.sendMessage(chatId, '⚠️ Error al procesar /set_expiration.');
  }
});

bot.onText(/\/link_usage (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const linkNumber = parseInt(match[1]);
  const userId = msg.from.id;

  try {
    const admins = await bot.getChatAdministrators(adminGroupChatId);
    if (!admins.some(admin => admin.user.id === userId)) {
      return bot.sendMessage(chatId, '🚫 Solo admins pueden usar este comando.');
    }
    const link = links.find(l => l.number === linkNumber);
    if (!link) {
      return bot.sendMessage(chatId, '⚠️ Enlace no encontrado.');
    }
    const views = linkViews.get(linkNumber) || [];
    const accessed = views.filter(v => v.action === 'accedió').length;
    const forwarded = views.filter(v => v.action === 'reenvió').length;
    const copied = views.filter(v => v.action === 'vio/copió').length;
    const usageText = `*📊 Uso del Enlace #${linkNumber}*\n` +
      `Total de interacciones: ${views.length}\n` +
      `Accesos directos: ${accessed}\n` +
      `Reenvíos: ${forwarded}\n` +
      `Vistos/Copiados: ${copied}\n` +
      `Expira: ${new Date(link.expirationTime).toLocaleString()}`;
    await bot.sendMessage(chatId, usageText, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('❌ Error en /link_usage:', error.message);
    await bot.sendMessage(chatId, '⚠️ Error al procesar /link_usage.');
  }
});

bot.onText(/\/auto_revoke (\d+) (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const linkNumber = parseInt(match[1]);
  const maxViews = parseInt(match[2]);
  const userId = msg.from.id;

  try {
    const admins = await bot.getChatAdministrators(adminGroupChatId);
    if (!admins.some(admin => admin.user.id === userId)) {
      return bot.sendMessage(chatId, '🚫 Solo admins pueden usar este comando.');
    }
    const link = links.find(l => l.number === linkNumber);
    if (!link) {
      return bot.sendMessage(chatId, '⚠️ Enlace no encontrado.');
    }
    link.maxViews = maxViews;
    await bot.sendMessage(chatId, 
      `🚫 Enlace #${linkNumber} se revocará automáticamente tras ${maxViews} vistas.`);
  } catch (error) {
    console.error('❌ Error en /auto_revoke:', error.message);
    await bot.sendMessage(chatId, '⚠️ Error al procesar /auto_revoke.');
  }
});

console.log('🚀 Bot iniciado correctamente 🎉');