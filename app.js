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
bot.beginDialogAction('hello', '/hello', { matches: /^(hello|hi|what'?s? up|good afternoon|good morning|good evening|hey|morning|afterno+n|evening)/i });

//=========================================================
// Bots Dialogs
//=========================================================

bot.dialog('/hello', [
  function (session) {
      var card = new builder.HeroCard(session)
          .title("Hello mate, long time no talk.")
          .text("Where do you want to go?")
          .images([
               builder.CardImage.create(session, "https://www.google.co.uk/url?sa=i&rct=j&q=&esrc=s&source=images&cd=&cad=rja&uact=8&ved=0ahUKEwiNlKLZwPbRAhVMnRQKHVBHBFUQjRwIBQ&url=https%3A%2F%2Fwww.theodysseyonline.com%2Fwanderlust-the-desire-travel&psig=AFQjCNF7zrAr16mUOqKVeGFW6wgMFCdBVQ&ust=1486299890533843")
          ]);
      var msg = new builder.Message(session).attachments([card]);
      session.send(msg);
      session.send("");
      session.beginDialog('/travel');
  },
  function (session, results) {
      // Display menu
      session.beginDialog('/travelmenu');
  },
  function (session, results) {
      // Always say goodbye
      session.send("Ok... Bye bye!");
  }
]);

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
