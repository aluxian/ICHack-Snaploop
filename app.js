var restify = require('restify');
var builder = require('botbuilder');
var request = require('request');

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
bot.beginDialogAction('hello', '/', { matches: /^(hello|hi|what'?s? up|good afternoon|good morning|good evening|hey|morning|afterno+n|evening)/i });

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
        builder.Prompts.choice(session, "What kind of travel are you looking for?", "camping|luxury|roadtrip|(quit)");
    },
    function (session, results) {
        // console.log(session);
        if (results.response && results.response.entity != '(quit)') {
            // Launch demo dialog
            session.send('Great, lemme find you something for %s!', session.userData.where);
            getWeather(session.userData.where, session);
            // session.send('FYI, the weather there is going to be ' + , ', so you might want to take that into consideration.');
        } else {
            // Exit the menu
            session.endDialog();
        }
    }
]);

//=========================================================
// Helper function
//=========================================================

function getWeather(location, session){
    //get geo data
    request
        .get({'url':'https://maps.googleapis.com/maps/api/geocode/json?address='+location+'&key='+process.env.GOOGLE_MAPS_API_KEY}, function(error, response, body){
            var geoJson = JSON.parse(body);
            var lat = geoJson.results[0].geometry.location.lat;
            var lng = geoJson.results[0].geometry.location.lng;

            //get the weather
            request
              .get({'url':'https://api.darksky.net/forecast/'+process.env.DARKSKY_API_KEY+'/'+lat+','+lng}, function(error, response, body){
                var weatherJson = JSON.parse(body); //currently.summary
                session.send('FYI, the weather there is going to be ' +weatherJson.currently.summary+ ', so you might want to take that into consideration.');
              })
        })
}

//=========================================================
// Debug thingies
//=========================================================

// getWeather('Southampton');
