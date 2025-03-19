const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const cron = require('node-cron');
const fs = require('fs');

// Token del bot
const token = '7861676131:AAFLv4dBIFiHV1OYc8BJH2U8kWPal7lpBMQ';
const bot = new TelegramBot(token);

// Configuración del servidor Express
const app = express();
const port = process.env.PORT || 10000;

// Middleware para parsear JSON
app.use(express.json());

// Configuración del webhook
const webhookUrl = 'https://entrelinks.onrender.com';

// Almacenar datos por grupo
let warnedUsers = {}; // { chatId: { userId: { username, reason, warnedAt, warningCount } } }
let reminderActive = {}; // { chatId: true/false }
let knownUsers = {}; // { chatId: { userId: { id, username, first_name } } } - Almacenar usuarios detectados
const logsFile = 'bot_logs.json';

// Número total de miembros (hardcodeado, ya que la API no lo proporciona)
const TOTAL_MEMBERS = 7795;

// Inicializar el archivo de logs si no existe
if (!fs.existsSync(logsFile)) {
  fs.writeFileSync(logsFile, JSON.stringify([]));
}

// Función para registrar una acción en el archivo de logs
function logAction(action, details) {
  const logs = JSON.parse(fs.readFileSync(logsFile));
  const timestamp = new Date().toLocaleString('es-ES');
  logs.push({ action, details, timestamp });
  fs.writeFileSync(logsFile, JSON.stringify(logs, null, 2));
}

// Ruta para el webhook
app.post(`/bot${token}`, (req, res) => {
  console.log('📩 Recibida actualización de Telegram:', JSON.stringify(req.body));
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Ruta para la raíz (/)
app.get('/', (req, res) => {
  res.send('Bot is running');
});

// Iniciar el servidor
app.listen(port, async () => {
  console.log(`🚀 Servidor escuchando en el puerto ${port}`);

  // Configurar el webhook
  await setWebhookWithRetry();
});

// Función para configurar el webhook con manejo de errores 429
async function setWebhookWithRetry() {
  try {
    console.log(`Configurando webhook: ${webhookUrl}/bot${token}`);
    await bot.setWebHook(`${webhookUrl}/bot${token}`);
    console.log(`✅ Webhook configurado: ${webhookUrl}/bot${token}`);
  } catch (error) {
    if (error.response && error.response.status === 429) {
      const retryAfter = error.response.data.parameters.retry_after || 1;
      console.warn(`⚠️ Error 429 Too Many Requests. Reintentando después de ${retryAfter} segundos...`);
      await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
      return setWebhookWithRetry(); // Reintentar
    }
    console.error(`❌ Error al configurar webhook: ${error.message}`);
  }
}

// Verificar si el usuario tiene foto de perfil pública y @username
async function checkUserProfile(user, chatId) {
  let hasPublicPhoto = true;
  let hasUsername = !!user.username;

  try {
    const photos = await bot.getUserProfilePhotos(user.id);
    hasPublicPhoto = photos.total_count > 0;
  } catch (error) {
    console.error(`❌ Error al verificar foto de perfil de ${user.id}: ${error.message}`);
    hasPublicPhoto = false; // Asumimos que no tiene foto pública si hay un error
  }

  return { hasPublicPhoto, hasUsername };
}

// Verificar si el bot es administrador del grupo
async function isBotAdmin(chatId) {
  try {
    const admins = await bot.getChatAdministrators(chatId);
    const botId = (await bot.getMe()).id;
    return admins.some(admin => admin.user.id === botId);
  } catch (error) {
    console.error(`❌ Error al verificar si el bot es administrador en ${chatId}: ${error.message}`);
    return false;
  }
}

// Función para añadir un usuario a la lista de usuarios conocidos
function addKnownUser(chatId, user) {
  if (!knownUsers[chatId]) knownUsers[chatId] = {};
  if (!knownUsers[chatId][user.id]) {
    knownUsers[chatId][user.id] = {
      id: user.id,
      username: user.username || null,
      first_name: user.first_name
    };
  }
}

// Función para enviar advertencia a un usuario en el grupo
async function warnUserInGroup(user, chatId, reason) {
  const username = user.username ? `@${user.username}` : user.first_name;
  const userId = user.id;
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toLocaleDateString('es-ES', { day: 'numeric', month: 'long' });

  // Inicializar warnedUsers para el grupo si no existe
  if (!warnedUsers[chatId]) warnedUsers[chatId] = {};

  // Incrementar el conteo de advertencias
  if (!warnedUsers[chatId][userId]) {
    warnedUsers[chatId][userId] = { username: user.username || user.first_name, reason, warnedAt: new Date(), warningCount: 0, chatId };
  }
  warnedUsers[chatId][userId].warningCount += 1;
  warnedUsers[chatId][userId].reason = reason; // Actualizar el motivo
  warnedUsers[chatId][userId].warnedAt = new Date(); // Actualizar la fecha de advertencia

  const message = `⚠️ ${username} (ID: ${userId}),\n` +
    `No tienes ${reason}. Por favor, configúralo antes del ${tomorrowStr}, ` +
    `o serás expulsado del grupo.\n` +
    `📊 Advertencias: ${warnedUsers[chatId][userId].warningCount}/3\n\n` +
    `📢 Equipo de Administración Entre Hijos`;

  try {
    await bot.sendMessage(chatId, message);
    logAction('advertencia', { userId, username, reason, warningCount: warnedUsers[chatId][userId].warningCount, chatId });
  } catch (error) {
    console.error(`❌ Error al enviar advertencia en el grupo para ${user.id}: ${error.message}`);
  }

  // Si el usuario alcanza 3 advertencias, generar mensaje de expulsión
  if (warnedUsers[chatId][userId].warningCount >= 3) {
    const kickMessage = `/kick @${username} (Motivo: ${reason}, 3 advertencias alcanzadas)`;
    try {
      await bot.sendMessage(chatId, kickMessage);
      logAction('expulsion', { userId, username, reason, warningCount: warnedUsers[chatId][userId].warningCount, chatId });
      delete warnedUsers[chatId][userId]; // Eliminar al usuario de la lista de advertidos
    } catch (error) {
      console.error(`❌ Error al enviar mensaje de expulsión para ${user.id}: ${error.message}`);
    }
  }
}

// Función para generar una barra de progreso
function generateProgressBar(progress, total) {
  const barLength = 20;
  const filled = Math.round((progress / total) * barLength);
  const empty = barLength - filled;
  return `📊 Progreso: [${'█'.repeat(filled)}${'-'.repeat(empty)}] ${Math.round((progress / total) * 100)}%`;
}

// Comando /m1: Mostrar lista de comandos
bot.onText(/\/m1/, async (msg) => {
  const chatId = msg.chat.id;
  if (msg.chat.type !== 'group' && msg.chat.type !== 'supergroup') {
    await bot.sendMessage(chatId, '🚫 Este comando solo puede usarse en grupos.\n\n📢 Equipo de Administración Entre Hijos');
    return;
  }

  // Verificar si el bot es administrador
  if (!(await isBotAdmin(chatId))) {
    await bot.sendMessage(chatId, '🚫 El bot debe ser administrador del grupo para usar este comando.\n\n📢 Equipo de Administración Entre Hijos');
    return;
  }

  const commandsList = `📋 **Lista de Comandos - Equipo de Administración Entre Hijos** 📋\n\n` +
    `🔍 **/busqueda**\n` +
    `   Escanea los usuarios detectados en el grupo y detecta aquellos sin foto de perfil pública o @username. Envía una advertencia en el grupo a cada usuario detectado.\n\n` +
    `🧹 **/limpiar**\n` +
    `   Genera mensajes de expulsión para los usuarios advertidos (formato: /kick @username (Motivo: ...)). Limpia la lista de advertidos.\n\n` +
    `📜 **/advertidos**\n` +
    `   Muestra una lista de los usuarios que han sido advertidos, con el motivo y la fecha de advertencia.\n\n` +
    `📊 **/detalles**\n` +
    `   Muestra estadísticas del grupo: número total de miembros, usuarios sin foto de perfil pública y usuarios sin @username.\n\n` +
    `⏰ **/recordatorio**\n` +
    `   Activa o desactiva un recordatorio diario para los usuarios advertidos.\n\n` +
    `📜 **/logs**\n` +
    `   Muestra las últimas 10 acciones del bot (solo para administradores).\n\n` +
    `ℹ️ **/m1**\n` +
    `   Muestra esta lista de comandos con una descripción detallada.\n\n` +
    `📢 **Funcionalidades automáticas**:\n` +
    `   - Detecta cambios de @username y lo notifica en el grupo.\n` +
    `   - Restringe mensajes de usuarios sin foto de perfil pública o @username, enviando una advertencia en el grupo.\n\n` +
    `📢 Equipo de Administración Entre Hijos`;

  try {
    await bot.sendMessage(chatId, commandsList, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error(`❌ Error al enviar mensaje de /m1 en ${chatId}: ${error.message}`);
    await bot.sendMessage(chatId, '❌ Ocurrió un error al mostrar la lista de comandos. Intenta de nuevo más tarde.\n\n📢 Equipo de Administración Entre Hijos');
  }
});

// Comando /detalles: Mostrar estadísticas del grupo
bot.onText(/\/detalles/, async (msg) => {
  const chatId = msg.chat.id;
  if (msg.chat.type !== 'group' && msg.chat.type !== 'supergroup') {
    await bot.sendMessage(chatId, '🚫 Este comando solo puede usarse en grupos.\n\n📢 Equipo de Administración Entre Hijos');
    return;
  }

  // Verificar si el bot es administrador
  if (!(await isBotAdmin(chatId))) {
    await bot.sendMessage(chatId, '🚫 El bot debe ser administrador del grupo para usar este comando.\n\n📢 Equipo de Administración Entre Hijos');
    return;
  }

  try {
    // Obtener información del chat
    const chat = await bot.getChat(chatId);

    // Obtener usuarios conocidos
    const users = knownUsers[chatId] ? Object.values(knownUsers[chatId]) : [];

    // Contar usuarios sin foto de perfil pública y sin @username
    let noPhotoCount = 0;
    let noUsernameCount = 0;
    for (const user of users) {
      const { hasPublicPhoto, hasUsername } = await checkUserProfile(user, chatId);
      if (!hasPublicPhoto) noPhotoCount++;
      if (!hasUsername) noUsernameCount++;
      await new Promise(resolve => setTimeout(resolve, 50)); // Pausa para evitar límites de la API
    }

    const statsMessage = `📊 **Estadísticas del grupo - ${chat.title}** 📊\n\n` +
      `👥 **Número total de miembros**: ${TOTAL_MEMBERS}\n` +
      `👤 **Usuarios detectados**: ${users.length}\n` +
      `📸 **Usuarios sin foto de perfil pública**: ${noPhotoCount} (basado en usuarios detectados)\n` +
      `📛 **Usuarios sin @username**: ${noUsernameCount} (basado en usuarios detectados)\n\n` +
      `📢 Equipo de Administración Entre Hijos`;

    await bot.sendMessage(chatId, statsMessage, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error(`❌ Error en /detalles: ${error.message}`);
    await bot.sendMessage(chatId, '❌ Ocurrió un error al obtener las estadísticas. Intenta de nuevo más tarde.\n\n📢 Equipo de Administración Entre Hijos');
  }
});

// Comando /busqueda: Escanear los usuarios detectados y advertir a los que no tengan foto de perfil pública o @username
bot.onText(/\/busqueda/, async (msg) => {
  const chatId = msg.chat.id;
  if (msg.chat.type !== 'group' && msg.chat.type !== 'supergroup') {
    await bot.sendMessage(chatId, '🚫 Este comando solo puede usarse en grupos.\n\n📢 Equipo de Administración Entre Hijos');
    return;
  }

  // Verificar si el bot es administrador
  if (!(await isBotAdmin(chatId))) {
    await bot.sendMessage(chatId, '🚫 El bot debe ser administrador del grupo para usar este comando.\n\n📢 Equipo de Administración Entre Hijos');
    return;
  }

  try {
    // Obtener usuarios conocidos
    const users = knownUsers[chatId] ? Object.values(knownUsers[chatId]) : [];
    const totalUsers = users.length;

    if (totalUsers === 0) {
      await bot.sendMessage(chatId, 'ℹ️ No se han detectado usuarios en el grupo todavía. Los usuarios se detectan cuando envían mensajes o se actualiza su estado en el grupo.\n\n📢 Equipo de Administración Entre Hijos');
      return;
    }

    // Enviar mensaje inicial con barra de progreso
    const progressMessage = await bot.sendMessage(chatId, `🔍 Iniciando búsqueda de usuarios sin foto de perfil pública o @username...\n` +
      `ℹ️ Nota: Solo se escanean los usuarios detectados (${totalUsers} de ${TOTAL_MEMBERS} miembros).\n` +
      `${generateProgressBar(0, totalUsers)}\n` +
      `Usuarios procesados: 0/${totalUsers}\n\n` +
      `📢 Equipo de Administración Entre Hijos`);

    const botId = (await bot.getMe()).id;
    let processedMembers = 0;
    let warnedCount = 0;

    // Procesar los usuarios detectados
    for (const user of users) {
      if (user.id === botId || user.is_bot) continue;

      const { hasPublicPhoto, hasUsername } = await checkUserProfile(user, chatId);
      if (!hasPublicPhoto) {
        await warnUserInGroup(user, chatId, 'foto de perfil pública');
        warnedCount++;
      } else if (!hasUsername) {
        await warnUserInGroup(user, chatId, '@username');
        warnedCount++;
      }

      processedMembers++;
      // Actualizar la barra de progreso cada 10 usuarios o al final
      if (processedMembers % 10 === 0 || processedMembers === totalUsers) {
        await bot.editMessageText(
          `🔍 Buscando usuarios sin foto de perfil pública o @username...\n` +
          `ℹ️ Nota: Solo se escanean los usuarios detectados (${totalUsers} de ${TOTAL_MEMBERS} miembros).\n` +
          `${generateProgressBar(processedMembers, totalUsers)}\n` +
          `Usuarios procesados: ${processedMembers}/${totalUsers}\n\n` +
          `📢 Equipo de Administración Entre Hijos`,
          { chat_id: chatId, message_id: progressMessage.message_id }
        );
      }

      // Pequeña pausa para evitar límites de la API
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    // Mensaje final
    const finalMessage = `✅ Búsqueda completada.\n` +
      `ℹ️ Nota: Solo se escanearon los usuarios detectados (${totalUsers} de ${TOTAL_MEMBERS} miembros).\n` +
      `${generateProgressBar(processedMembers, totalUsers)}\n` +
      `Usuarios procesados: ${processedMembers}/${totalUsers}\n` +
      `Se advirtieron a ${warnedCount} usuarios.\n` +
      `Usa /advertidos para ver la lista de advertidos o /limpiar para preparar la expulsión.\n\n` +
      `📢 Equipo de Administración Entre Hijos`;

    await bot.editMessageText(finalMessage, { chat_id: chatId, message_id: progressMessage.message_id });
  } catch (error) {
    console.error(`❌ Error en /busqueda: ${error.message}`);
    await bot.sendMessage(chatId, '❌ Ocurrió un error al realizar la búsqueda. Intenta de nuevo más tarde.\n\n📢 Equipo de Administración Entre Hijos');
  }
});

// Comando /limpiar: Generar mensajes de expulsión
bot.onText(/\/limpiar/, async (msg) => {
  const chatId = msg.chat.id;
  if (msg.chat.type !== 'group' && msg.chat.type !== 'supergroup') {
    await bot.sendMessage(chatId, '🚫 Este comando solo puede usarse en grupos.\n\n📢 Equipo de Administración Entre Hijos');
    return;
  }

  // Verificar si el bot es administrador
  if (!(await isBotAdmin(chatId))) {
    await bot.sendMessage(chatId, '🚫 El bot debe ser administrador del grupo para usar este comando.\n\n📢 Equipo de Administración Entre Hijos');
    return;
  }

  if (!warnedUsers[chatId] || Object.keys(warnedUsers[chatId]).length === 0) {
    await bot.sendMessage(chatId, 'ℹ️ No hay usuarios advertidos para limpiar.\n\n📢 Equipo de Administración Entre Hijos');
    return;
  }

  try {
    await bot.sendMessage(chatId, '📋 Generando mensajes de expulsión...\n\n📢 Equipo de Administración Entre Hijos');
    for (const userId in warnedUsers[chatId]) {
      const user = warnedUsers[chatId][userId];
      const reason = user.reason === 'foto de perfil pública' ? 'falta foto de perfil pública' : 'falta @username';
      const message = `/kick @${user.username} (Motivo: ${reason})`;
      await bot.sendMessage(chatId, message);
      logAction('expulsion_manual', { userId, username: user.username, reason, chatId });
      // Pequeña pausa para evitar límites de la API
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    // Limpiar la lista de advertidos después de generar los mensajes
    warnedUsers[chatId] = {};
    await bot.sendMessage(chatId, '✅ Mensajes de expulsión generados. La lista de advertidos ha sido limpiada.\n\n📢 Equipo de Administración Entre Hijos');
  } catch (error) {
    console.error(`❌ Error en /limpiar: ${error.message}`);
    await bot.sendMessage(chatId, '❌ Ocurrió un error al generar los mensajes de expulsión. Intenta de nuevo más tarde.\n\n📢 Equipo de Administración Entre Hijos');
  }
});

// Comando /advertidos: Mostrar lista de usuarios advertidos
bot.onText(/\/advertidos/, async (msg) => {
  const chatId = msg.chat.id;
  if (msg.chat.type !== 'group' && msg.chat.type !== 'supergroup') {
    await bot.sendMessage(chatId, '🚫 Este comando solo puede usarse en grupos.\n\n📢 Equipo de Administración Entre Hijos');
    return;
  }

  // Verificar si el bot es administrador
  if (!(await isBotAdmin(chatId))) {
    await bot.sendMessage(chatId, '🚫 El bot debe ser administrador del grupo para usar este comando.\n\n📢 Equipo de Administración Entre Hijos');
    return;
  }

  if (!warnedUsers[chatId] || Object.keys(warnedUsers[chatId]).length === 0) {
    await bot.sendMessage(chatId, 'ℹ️ No hay usuarios advertidos actualmente.\n\n📢 Equipo de Administración Entre Hijos');
    return;
  }

  try {
    let message = '📜 Lista de usuarios advertidos:\n\n';
    for (const userId in warnedUsers[chatId]) {
      const user = warnedUsers[chatId][userId];
      const warnedAt = new Date(user.warnedAt).toLocaleString('es-ES');
      message += `👤 ${user.username}\n` +
        `   Motivo: falta ${user.reason}\n` +
        `   📊 Advertencias: ${user.warningCount}/3\n` +
        `   ⏰ Advertido el: ${warnedAt}\n\n`;
    }
    message += '📢 Equipo de Administración Entre Hijos';

    await bot.sendMessage(chatId, message);
  } catch (error) {
    console.error(`❌ Error en /advertidos: ${error.message}`);
    await bot.sendMessage(chatId, '❌ Ocurrió un error al mostrar la lista de advertidos. Intenta de nuevo más tarde.\n\n📢 Equipo de Administración Entre Hijos');
  }
});

// Comando /recordatorio: Activar/desactivar recordatorio diario
bot.onText(/\/recordatorio/, async (msg) => {
  const chatId = msg.chat.id;
  if (msg.chat.type !== 'group' && msg.chat.type !== 'supergroup') {
    await bot.sendMessage(chatId, '🚫 Este comando solo puede usarse en grupos.\n\n📢 Equipo de Administración Entre Hijos');
    return;
  }

  // Verificar si el bot es administrador
  if (!(await isBotAdmin(chatId))) {
    await bot.sendMessage(chatId, '🚫 El bot debe ser administrador del grupo para usar este comando.\n\n📢 Equipo de Administración Entre Hijos');
    return;
  }

  // Verificar si el usuario es administrador
  try {
    const admins = await bot.getChatAdministrators(chatId);
    if (!admins.some(admin => admin.user.id === msg.from.id)) {
      await bot.sendMessage(chatId, '🚫 Este comando solo puede ser usado por administradores.\n\n📢 Equipo de Administración Entre Hijos');
      return;
    }

    reminderActive[chatId] = !reminderActive[chatId];
    const status = reminderActive[chatId] ? 'activado' : 'desactivado';
    await bot.sendMessage(chatId, `⏰ Recordatorio diario ${status}.\n\n📢 Equipo de Administración Entre Hijos`);
    logAction('recordatorio', { status, chatId });
  } catch (error) {
    console.error(`❌ Error en /recordatorio: ${error.message}`);
    await bot.sendMessage(chatId, '❌ Ocurrió un error al configurar el recordatorio. Intenta de nuevo más tarde.\n\n📢 Equipo de Administración Entre Hijos');
  }
});

// Programar recordatorio diario con node-cron (a las 9:00 AM todos los días)
cron.schedule('0 9 * * *', async () => {
  for (const chatId in reminderActive) {
    if (!reminderActive[chatId]) continue;

    if (!warnedUsers[chatId]) continue;

    for (const userId in warnedUsers[chatId]) {
      const user = warnedUsers[chatId][userId];
      const username = user.username;
      const reason = user.reason;
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowStr = tomorrow.toLocaleDateString('es-ES', { day: 'numeric', month: 'long' });

      const message = `⏰ Recordatorio, ${username} (ID: ${userId}),\n` +
        `No tienes ${reason}. Por favor, configúralo antes del ${tomorrowStr}, ` +
        `o serás expulsado del grupo.\n` +
        `📊 Advertencias: ${user.warningCount}/3\n\n` +
        `📢 Equipo de Administración Entre Hijos`;

      try {
        await bot.sendMessage(chatId, message);
        logAction('recordatorio_enviado', { userId, username, reason, chatId });
      } catch (error) {
        console.error(`❌ Error al enviar recordatorio a ${userId} en ${chatId}: ${error.message}`);
      }
    }
  }
});

// Comando /logs: Mostrar las últimas 10 acciones del bot (solo para administradores)
bot.onText(/\/logs/, async (msg) => {
  const chatId = msg.chat.id;
  if (msg.chat.type !== 'group' && msg.chat.type !== 'supergroup') {
    await bot.sendMessage(chatId, '🚫 Este comando solo puede usarse en grupos.\n\n📢 Equipo de Administración Entre Hijos');
    return;
  }

  // Verificar si el bot es administrador
  if (!(await isBotAdmin(chatId))) {
    await bot.sendMessage(chatId, '🚫 El bot debe ser administrador del grupo para usar este comando.\n\n📢 Equipo de Administración Entre Hijos');
    return;
  }

  // Verificar si el usuario es administrador
  try {
    const admins = await bot.getChatAdministrators(chatId);
    if (!admins.some(admin => admin.user.id === msg.from.id)) {
      await bot.sendMessage(chatId, '🚫 Este comando solo puede ser usado por administradores.\n\n📢 Equipo de Administración Entre Hijos');
      return;
    }

    const logs = JSON.parse(fs.readFileSync(logsFile));
    const recentLogs = logs.slice(-10).reverse();
    if (recentLogs.length === 0) {
      await bot.sendMessage(chatId, 'ℹ️ No hay acciones registradas.\n\n📢 Equipo de Administración Entre Hijos');
      return;
    }

    let message = '📜 **Últimas 10 acciones del bot** 📜\n\n';
    for (const log of recentLogs) {
      message += `⏰ ${log.timestamp}\n` +
        `📋 Acción: ${log.action}\n` +
        `   Detalles: ${JSON.stringify(log.details)}\n\n`;
    }
    message += '📢 Equipo de Administración Entre Hijos';

    await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error(`❌ Error en /logs: ${error.message}`);
    await bot.sendMessage(chatId, '❌ Ocurrió un error al mostrar los logs. Intenta de nuevo más tarde.\n\n📢 Equipo de Administración Entre Hijos');
  }
});

// Detectar usuarios a través de actualizaciones de chat_member
bot.on('chat_member', async (update) => {
  const chatId = update.chat.id;
  if (update.chat.type !== 'group' && update.chat.type !== 'supergroup') return;

  // Verificar si el bot es administrador
  if (!(await isBotAdmin(chatId))) return;

  const newMember = update.new_chat_member;
  const oldMember = update.old_chat_member;

  if (newMember && newMember.user) {
    addKnownUser(chatId, newMember.user);
  }
  if (oldMember && oldMember.user) {
    addKnownUser(chatId, oldMember.user);
  }

  // Detectar cambios de @username
  if (newMember && oldMember) {
    const oldUsername = oldMember.user.username;
    const newUsername = newMember.user.username;

    if (oldUsername !== newUsername && oldUsername && newUsername) {
      try {
        await bot.sendMessage(chatId, `🔄 @${oldUsername} ha cambiado su nombre a @${newUsername}\n\n📢 Equipo de Administración Entre Hijos`);
        logAction('cambio_username', { oldUsername, newUsername, chatId });
        console.log(`📩 Cambio de @username detectado: @${oldUsername} a @${newUsername}`);
      } catch (error) {
        console.error(`❌ Error al notificar cambio de @username: ${error.message}`);
      }
    }
  }
});

// Detectar usuarios a través de mensajes y restringir mensajes de usuarios sin foto de perfil pública o @username
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  if (msg.chat.type !== 'group' && msg.chat.type !== 'supergroup') return;
  if (msg.from.is_bot) return;

  // Verificar si el bot es administrador
  if (!(await isBotAdmin(chatId))) return;

  // Añadir usuario a la lista de conocidos
  addKnownUser(chatId, msg.from);

  if (msg.text && msg.text.startsWith('/')) return; // Permitir comandos

  try {
    const { hasPublicPhoto, hasUsername } = await checkUserProfile(msg.from, chatId);
    if (!hasPublicPhoto || !hasUsername) {
      const username = hasUsername ? `@${msg.from.username}` : msg.from.first_name;
      const reason = !hasPublicPhoto ? 'foto de perfil pública' : '@username';

      // Eliminar el mensaje del usuario
      try {
        await bot.deleteMessage(chatId, msg.message_id);
      } catch (error) {
        console.error(`❌ Error al eliminar mensaje de ${username}: ${error.message}`);
      }

      // Enviar advertencia en el grupo
      await bot.sendMessage(chatId, `🚫 ${username}, por favor configura tu ${reason} para poder hablar en el grupo.\n\n📢 Equipo de Administración Entre Hijos`);
    }
  } catch (error) {
    console.error(`❌ Error al procesar mensaje en ${chatId}: ${error.message}`);
  }
});

console.log('🚀 Bot iniciado correctamente 🎉');