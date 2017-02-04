var restify = require('restify');
var builder = require('botbuilder');

//=========================================================
// Bot Setup
//=========================================================

// Setup Restify Server
var server = restify.createServer();
server.listen(process.env.port || process.env.PORT || 3978, function () {
  console.log('%s listening to %s', server.name, server.url);
});

// Create chat bot
var connector = new builder.ChatConnector({
  appId: process.env.MICROSOFT_APP_ID,
  appPassword: process.env.MICROSOFT_APP_PASSWORD
});
var bot = new builder.UniversalBot(connector);
server.post('/api/messages', connector.listen());

//=========================================================
// Bot Setup CONSOLE
//=========================================================

// Create chat bot
// var connector = new builder.ConsoleConnector().listen();
// var bot = new builder.UniversalBot(connector);

//=========================================================
// Bots Middleware
//=========================================================

// Anytime the major version is incremented any existing conversations will be restarted.
bot.use(builder.Middleware.dialogVersion({ version: 1.0, resetCommand: /^reset/i }));

//=========================================================
// Bots Global Actions
//=========================================================

// bot.endConversationAction('stop', 'Ok, let me know when you want to start again.', { matches: /^(stop|exit|close|off)/i });
// bot.beginDialogAction('start', 'start', { matches: /^he*lp/i });

//=========================================================
// Bots Dialogs
//=========================================================

bot.dialog('/', [
  function (session) {
    session.send('Hey, let\'s play!');
    session.beginDialog('/guess');
  },
]);

bot.dialog('/guess', [
  function (session) {
    builder.Prompts.attachment(session, 'Send me a photo that looks like: dice, jewellery, ring');
  },
  function (session, result) {
    console.log('got response:', result);
    var photoUrl = result.response[0].contentUrl;
  },
]);
