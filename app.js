var restify = require('restify');
var builder = require('botbuilder');

//=========================================================
// Bot Setup
//=========================================================

// // Setup Restify Server
// var server = restify.createServer();
// server.listen(process.env.port || process.env.PORT || 3978, function () {
//   console.log('%s listening to %s', server.name, server.url);
// });
//
// // Create chat bot
// var connector = new builder.ChatConnector({
//   appId: process.env.MICROSOFT_APP_ID,
//   appPassword: process.env.MICROSOFT_APP_PASSWORD
// });
// var bot = new builder.UniversalBot(connector);
// server.post('/api/messages', connector.listen());

//=========================================================
// Bot Setup CONSOLE
//=========================================================

// Create chat bot
var connector = new builder.ConsoleConnector().listen();
var bot = new builder.UniversalBot(connector);

//=========================================================
// Bots Middleware
//=========================================================

// Anytime the major version is incremented any existing conversations will be restarted.
bot.use(builder.Middleware.dialogVersion({ version: 1.0, resetCommand: /^reset/i }));

//=========================================================
// Bots Global Actions
//=========================================================

bot.endConversationAction('goodbye', 'Goodbye :)', { matches: /^good ?bye/i });
bot.beginDialogAction('help', 'Good luck :)', { matches: /^he*lp/i });
bot.beginDialogAction('hello', '/hello', { matches: /^(hello|hi|what'?s? up|good afternoon|good morning|good evening|hey|morning|afterno+n|evening)/i });

//=========================================================
// Bots Dialogs
//=========================================================

bot.dialog('/', [
  function (session) {
    var card = new builder.HeroCard(session)
      .title("Travound")
      .text("Find the best getaways for your budget");
    var msg = new builder.Message(session).attachments([card]);
    session.send(msg);
    session.beginDialog('/plantrip');
  },
]);

bot.dialog('/plantrip', [
  function (session) {
    session.send("Hi! I can find awesome trips for you. Where do you want to go?");
  }
]);
