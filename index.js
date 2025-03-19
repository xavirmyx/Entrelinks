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
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Iniciar el servidor
app.listen(port, () => {
  console.log(`🚀 Servidor escuchando en el puerto ${port}`);
  const webhookUrl = process.env.WEBHOOK_URL || `https://tu-app.onrender.com/bot${token}`; // Ajusta esto en Render
  bot.setWebHook(webhookUrl)
    .then(() => console.log(`✅ Webhook configurado: ${webhookUrl}`))
    .catch(err => console.error(`❌ Error al configurar webhook: ${err.message}`));
});

// Función para extraer eventos deportivos de la página
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

    // Selector ajustado para la estructura de rbtv77.email/es
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

    return events;
  } catch (error) {
    console.error(`❌ Error al extraer eventos: ${error.message}`);
    return [];
  }
}

// Menú principal
async function sendMainMenu(chatId) {
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

// Mostrar lista de eventos
async function sendEventList(chatId, sportType) {
  const events = await fetchSportsEvents();
  const filteredEvents = sportType === 'football'
    ? events.filter(e => e.sport.toLowerCase().includes('fútbol') || e.sport.toLowerCase().includes('futbol'))
    : events.filter(e => !e.sport.toLowerCase().includes('fútbol') && !e.sport.toLowerCase().includes('futbol'));

  if (filteredEvents.length === 0) {
    await bot.sendMessage(chatId, '⚠️ No hay eventos disponibles ahora.');
    return;
  }

  const keyboard = filteredEvents.map((event, index) => [
    { text: `${event.time} - ${event.teams}`, callback_data: `event_${index}` },
  ]);

  const options = {
    reply_markup: {
      inline_keyboard: keyboard,
    },
  };
  await bot.sendMessage(chatId, `📅 Eventos de ${sportType === 'football' ? 'Fútbol' : 'Otros Deportes'}:`, options);

  // Almacenar eventos temporalmente para accederlos desde los callbacks
  bot.tempEvents = filteredEvents;
}

// Comando /start
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  sendMainMenu(chatId);
});

// Manejar callbacks de los botones
bot.on('callback_query', async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const data = callbackQuery.data;

  await bot.answerCallbackQuery(callbackQuery.id);

  if (data === 'football') {
    await sendEventList(chatId, 'football');
  } else if (data === 'other_sports') {
    await sendEventList(chatId, 'other_sports');
  } else if (data === 'help') {
    await bot.sendMessage(chatId, 'ℹ️ Usa este bot para ver eventos deportivos en vivo.\n1. Selecciona una categoría.\n2. Elige un evento.\n3. Recibe el enlace directo.');
  } else if (data.startsWith('event_')) {
    const eventIndex = parseInt(data.split('_')[1]);
    const event = bot.tempEvents[eventIndex];
    if (event) {
      const options = {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔙 Volver al Menú', callback_data: 'back_to_menu' }],
          ],
        },
      };
      await bot.sendMessage(chatId, `🏟 ${event.teams}\n🕒 ${event.time}\n🔗 [Ver en vivo](${event.link})`, {
        parse_mode: 'Markdown',
        ...options,
      });
    }
  } else if (data === 'back_to_menu') {
    await sendMainMenu(chatId);
  }
});

// Comando /menu (opcional)
bot.onText(/\/menu/, (msg) => {
  const chatId = msg.chat.id;
  sendMainMenu(chatId);
});

console.log('🚀 Bot de Eventos Deportivos iniciado correctamente 🎉');