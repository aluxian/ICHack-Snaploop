var restify = require('restify');
var builder = require('botbuilder');

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
        builder.Prompts.text(session, "I can find awesome trips for you.\nWhere do you want to go?");
    },
    function (session, results) {
        session.userData.where = results.response;
        session.send('Hello ' + 'session.userData.name' + '\nI will find you some trips to ' + session.userData.where);
        session.beginDialog('/tripbuttons');
    }
]);

bot.dialog('/tripbuttons', [
    function (session) {
        builder.Prompts.choice(session, "What kind of travel are you looking for?", "camping|luxury|roadtrip|(quit)");
    },
    function (session, results) {
        if (results.response && results.response.entity != '(quit)') {
            // Launch demo dialog
            session.send('Great, lemme find you something!')
        } else {
            // Exit the menu
            session.endDialog();
        }
    }
])
