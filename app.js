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
// Bots Middleware
//=========================================================

// Anytime the major version is incremented any existing conversations will be restarted.
bot.use(builder.Middleware.dialogVersion({ version: 1.0, resetCommand: /^reset/i }));

//=========================================================
// Bots Global Actions
//=========================================================

bot.endConversationAction('goodbye', 'Goodbye :)', { matches: /^good ?bye/i });
bot.beginDialogAction('help', 'Good luck :)', { matches: /^he*lp/i });

//=========================================================
// Bots Dialogs
//=========================================================

bot.dialog('/', [
  function (session) {
      // Send a greeting and show help.
      var card = new builder.HeroCard(session)
          .title("Travound")
          .text("Find the best getaways for your budget");
      var msg = new builder.Message(session).attachments([card]);
      session.send(msg);
      session.send("Hi! I can find awesome trips for you. Where do you want to go?");
      session.beginDialog('/');
  },
  function (session, results) {
      // Display menu
      session.beginDialog('/menu');
  },
  function (session, results) {
      // Always say goodbye
      session.send("Ok... See you later!");
  }
]);
