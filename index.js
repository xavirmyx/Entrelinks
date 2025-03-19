const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');

// Token del bot
const token = '7861676131:AAFLv4dBIFiHV1OYc8BJH2U8kWPal7lpBMQ';
const bot = new TelegramBot(token);

// Configuración del servidor Express
const app = express();
const port = process.env.PORT || 10000;

// URL de la página de eventos deportivos
const SPORTS_URL = 'https://www.rbtv77.email/es';

// Middleware para parsear JSON
app.use(express.json());

// Ruta para el webhook
app.post(`/bot${token}`, (req, res) => {
  console.log('📩 Recibida actualización de Telegram:', req.body); // Log para depurar
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Iniciar el servidor
app.listen(port, () => {
  console.log(`🚀 Servidor escuchando en el puerto ${port}`);
  const webhookUrl = process.env.WEBHOOK_URL || 'https://entrelinks.onrender.com'; // ¡Reemplaza con tu URL real!
  bot.setWebHook(`${webhookUrl}/bot${token}`)
    .then(() => console.log(`✅ Webhook configurado: ${webhookUrl}/bot${token}`))
    .catch(err => console.error(`❌ Error al configurar webhook: ${err.message}`));
});

// Función para extraer eventos deportivos de la página (simplificada para pruebas)
async function fetchSportsEvents() {
  try {
    const { data } = await axios.get(SPORTS_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'es-ES,es;q=0.8,en-US;q=0.5,en;q=0.3',
        'Referer': 'https://www.google.com/',
      },
      timeout: 10000,
    });
    const $ = cheerio.load(data);
    const events = [];

    $('div.evento-card').each((i, element) => {
      const time = $(element).find('.hora').text().trim() || 'Hora no especificada';
      const teams = $(element).find('.equipos').text().trim();
      const link = $(element).find('a[href*="stream"]').attr('href');
      const sport = $(element).find('.deporte').text().trim() || 'Desconocido';

      if (teams && link) {
        events.push({
          time,
          teams,
          link: link.startsWith('http') ? link : `https://www.rbtv77.email${link}`,
          sport,
        });
      }
    });

    console.log(`✅ Eventos extraídos: ${events.length}`);
    return events;
  } catch (error) {
    console.error(`❌ Error al extraer eventos: ${error.message}`);
    return [];
  }
}

// Menú principal
async function sendMainMenu(chatId) {
  console.log(`📤 Enviando menú principal a ${chatId}`);
  const options = {
    reply_markup: {
      inline_keyboard: [
        [{ text: '⚽ Partidos de Fútbol', callback_data: 'football' }],
        [{ text: '🏀 Otros Deportes', callback_data: 'other_sports' }],
        [{ text: 'ℹ️ Ayuda', callback_data: 'help' }],
      ],
    },
  };
  await bot.sendMessage(chatId, '🏟 Bienvenido al Bot de Eventos Deportivos en Vivo\nSelecciona una opción:', options);
}

// Comando /start
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  console.log(`📩 Comando /start recibido de ${chatId}`);
  sendMainMenu(chatId);
});

// Comando /test (para depuración)
bot.onText(/\/test/, (msg) => {
  const chatId = msg.chat.id;
  console.log(`📩 Comando /test recibido de ${chatId}`);
  bot.sendMessage(chatId, '✅ ¡El bot está vivo!');
});

console.log('🚀 Bot de Eventos Deportivos iniciado correctamente 🎉');