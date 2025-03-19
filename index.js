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

// URL base de repelisplus.lat
const REPELIS_URL = 'https://repelisplus.lat';

// Middleware para parsear JSON
app.use(express.json());

// Ruta para el webhook
app.post(`/bot${token}`, (req, res) => {
  console.log('📩 Recibida actualización de Telegram:', JSON.stringify(req.body));
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Ruta para el reproductor web
app.get('/play', (req, res) => {
  const streamUrl = req.query.url;
  if (!streamUrl) {
    return res.status(400).send('No se proporcionó URL de stream.');
  }

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Reproductor RepelisPlus</title>
      <style>
        body { margin: 0; background: #000; display: flex; justify-content: center; align-items: center; height: 100vh; }
        iframe { width: 100%; max-width: 800px; height: 450px; border: none; }
      </style>
    </head>
    <body>
      <iframe src="${streamUrl}" allowfullscreen></iframe>
    </body>
    </html>
  `;
  res.send(html);
});

// Iniciar el servidor
app.listen(port, () => {
  console.log(`🚀 Servidor escuchando en el puerto ${port}`);
  const webhookUrl = process.env.WEBHOOK_URL || 'https://entrelinks.onrender.com';
  bot.setWebHook(`${webhookUrl}/bot${token}`)
    .then(() => console.log(`✅ Webhook configurado: ${webhookUrl}/bot${token}`))
    .catch(err => console.error(`❌ Error al configurar webhook: ${err.message}`));
});

// Función para extraer películas de la página principal
async function fetchMovies() {
  try {
    const { data } = await axios.get(REPELIS_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      },
      timeout: 10000,
    });
    const $ = cheerio.load(data);
    const movies = [];

    $('article.item').each((i, element) => {
      const title = $(element).find('.title').text().trim() || 'Película sin título';
      const link = $(element).find('a').attr('href');
      if (title && link) {
        movies.push({
          title,
          link: link.startsWith('http') ? link : `${REPELIS_URL}${link}`,
        });
      }
    });

    console.log(`✅ Películas extraídas: ${movies.length}`);
    return movies;
  } catch (error) {
    console.error(`❌ Error al extraer películas: ${error.message}`);
    return [];
  }
}

// Función para extraer reproductores de una película
async function fetchPlayers(movieUrl) {
  try {
    const { data } = await axios.get(movieUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      },
      timeout: 10000,
    });
    const $ = cheerio.load(data);
    const players = [];

    $('ul.list-server li').each((i, element) => {
      const name = $(element).text().trim() || `Reproductor ${i + 1}`;
      const link = $(element).attr('data-url') || $(element).find('iframe').attr('src');
      if (link) {
        players.push({ name, link });
      }
    });

    console.log(`✅ Reproductores extraídos: ${players.length}`);
    return players;
  } catch (error) {
    console.error(`❌ Error al extraer reproductores: ${error.message}`);
    return [];
  }
}

// Función para buscar una película específica
async function searchMovie(query) {
  const movies = await fetchMovies();
  const results = movies.filter(movie => 
    movie.title.toLowerCase().includes(query.toLowerCase())
  );
  return results;
}

// Menú principal
async function sendMainMenu(chatId) {
  console.log(`📤 Enviando menú principal a ${chatId}`);
  const movies = await fetchMovies();

  if (movies.length === 0) {
    await bot.sendMessage(chatId, '⚠️ No se pudieron cargar películas de repelisplus.lat. Intenta más tarde.');
    return;
  }

  const keyboard = movies.slice(0, 10).map((movie, index) => [
    { text: movie.title, callback_data: `movie_${index}` },
  ]);

  const options = {
    reply_markup: {
      inline_keyboard: [
        ...keyboard,
        [{ text: '🔍 Buscar película', callback_data: 'search' }],
        [{ text: 'ℹ️ Ayuda', callback_data: 'help' }],
      ],
    },
  };
  await bot.sendMessage(chatId, '🎬 Bienvenido al Bot de Películas RepelisPlus\nSelecciona una película reciente:', options);

  bot.tempMovies = movies;
}

// Mostrar resultados de búsqueda
async function sendSearchResults(chatId, query) {
  const results = await searchMovie(query);

  if (results.length === 0) {
    await bot.sendMessage(chatId, `⚠️ No se encontraron resultados para "${query}".`);
    return;
  }

  const keyboard = results.slice(0, 10).map((movie, index) => [
    { text: movie.title, callback_data: `movie_${bot.tempMovies.indexOf(movie)}` },
  ]);

  const options = {
    reply_markup: {
      inline_keyboard: [
        ...keyboard,
        [{ text: '🔙 Retroceder', callback_data: 'back_to_menu' }],
      ],
    },
  };
  await bot.sendMessage(chatId, `🎬 Resultados para "${query}":`, options);
}

// Mostrar opciones de reproductores
async function sendPlayerOptions(chatId, movie) {
  const players = await fetchPlayers(movie.link);
  if (players.length === 0) {
    await bot.sendMessage(chatId, `⚠️ No se encontraron reproductores para "${movie.title}".`);
    return;
  }

  const webhookUrl = process.env.WEBHOOK_URL || 'https://entrelinks.onrender.com';
  const keyboard = players.map((player, index) => [
    { text: player.name, url: `${webhookUrl}/play?url=${encodeURIComponent(player.link)}` },
  ]);

  const options = {
    reply_markup: {
      inline_keyboard: [
        ...keyboard,
        [{ text: '🔙 Retroceder', callback_data: 'back_to_menu' }],
      ],
    },
  };
  await bot.sendMessage(chatId, `🎬 Elige un reproductor para "${movie.title}":`, options);
}

// Comando /start
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  console.log(`📩 Comando /start recibido de ${chatId}`);
  sendMainMenu(chatId);
});

// Comando /menu
bot.onText(/\/menu/, (msg) => {
  const chatId = msg.chat.id;
  console.log(`📩 Comando /menu recibido de ${chatId}`);
  sendMainMenu(chatId);
});

// Comando /test
bot.onText(/\/test/, (msg) => {
  const chatId = msg.chat.id;
  console.log(`📩 Comando /test recibido de ${chatId}`);
  bot.sendMessage(chatId, '✅ ¡El bot está vivo!');
});

// Comando /buscar
bot.onText(/\/buscar (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const query = match[1];
  console.log(`📩 Comando /buscar recibido de ${chatId}: ${query}`);
  sendSearchResults(chatId, query);
});

// Manejar callbacks de los botones
bot.on('callback_query', async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const data = callbackQuery.data;

  console.log(`📩 Callback recibido: ${data}`);
  await bot.answerCallbackQuery(callbackQuery.id);

  if (data.startsWith('movie_')) {
    const index = parseInt(data.split('_')[1]);
    const movie = bot.tempMovies[index];
    if (movie) {
      await sendPlayerOptions(chatId, movie);
    }
  } else if (data === 'search') {
    await bot.sendMessage(chatId, '🔍 Escribe /buscar <nombre de la película> para buscar.');
  } else if (data === 'back_to_menu') {
    await sendMainMenu(chatId);
  } else if (data === 'help') {
    await bot.sendMessage(chatId, 'ℹ️ Usa este bot para ver películas de repelisplus.lat:\n- /start o /menu: Ver películas recientes.\n- /buscar <nombre>: Buscar una película.\n- /test: Verificar estado.');
  }
});

console.log('🚀 Bot de Películas RepelisPlus iniciado correctamente 🎉');