var restify = require('restify');
var builder = require('botbuilder');
var Clarifai = require('clarifai');

// instantiate a new Clarifai app passing in your clientId and clientSecret
var clarifai = new Clarifai.App(
  process.env.CLARIFAI_CLIENTID,
  process.env.CLARIFAI_SECRET
);

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

var DB = {
  currentGameTags: null,
  currentGameTagsTemp: null,
  currentGameSenderAddress: null,
  playerTakingPhoto: null,
  // lastActivityFromPlayerTakingPhoto: 0,
  players: [],
};

bot.dialog('/', [
  function (session) {
    var address = JSON.stringify(session.message.address);
    if (!DB.players.includes(address)) {
      DB.players.push(address);
    }
    session.sendTyping();
    session.send('Hey, let\'s play!');
    session.beginDialog('/guess');
  },
]);

bot.dialog('/guess', [
  function (session) {
    if (DB.currentGameTags) {
      session.sendTyping();
      builder.Prompts.attachment(session, 'Send me a photo that looks like: ' + DB.currentGameTags.join(', '));
    } else if (DB.playerTakingPhoto) {
      session.send('Please wait, somebody is taking a photo right now');
    } else {
      session.endDialog();
      session.beginDialog('/guessed');
    }
  },
  function (session, result) {
    session.sendTyping();
    clarifai.models.predict(Clarifai.GENERAL_MODEL, result.response[0].contentUrl).then(
      function(response) {
        var tags = processTags(response.outputs[0].data.concepts.map(function(o) {return o.name;}));
        if (!tags.length) {
          session.send('Sorry, I could not identify anything in your photo. Try again');
          session.endDialog();
          session.beginDialog('/guess');
        } else if (tagsMatch(DB.currentGameTags, tags)) {
          session.send('You guessed, yay! 🎊');
          session.endDialog();
          session.beginDialog('/guessed');

          // notify the author of the pic
          var senderAddress = JSON.parse(DB.currentGameSenderAddress);
          var msg = new builder.Message().address(senderAddress).text('Somebody guessed your image!');
          bot.send(msg, function (err) { if (err) { console.error(err); } });

          // notify everyone else
          var currentAddress = JSON.stringify(session.message.address);
          DB.players.forEach(function(playerAddress) {
            if (!addressIsSameUser(playerAddress, currentAddress) && !addressIsSameUser(playerAddress, DB.currentGameSenderAddress)) {
              var address = JSON.parse(playerAddress);
              var msg1 = new builder.Message().address(address).text('Hah, somebody guessed it already');
              var msg2 = new builder.Message().address(address).text('Hang on, now they have to send an image!');
              bot.send(msg1, function (err) { if (err) { console.error(err); } });
              bot.send(msg2, function (err) { if (err) { console.error(err); } });
            }
          });
        } else {
          session.send('No, that\'s not it');
          session.endDialog();
          session.beginDialog('/guess');
        }
      },
      function(err) {
        console.error(err);
        session.send('Error. Let\'s try again');
        session.endDialog();
        session.beginDialog('/guess');
      }
    );
  }
]);

bot.dialog('/guessed', [
  function (session) {
    // DB.lastActivityFromPlayerTakingPhoto = new Date().getTime();
    DB.playerTakingPhoto = JSON.stringify(session.message.address);
    session.send('Now it\'s your turn to take a photo. I\'ll ask everyone else playing the game to guess!');
    builder.Prompts.attachment(session, 'Go ahead, I\'m waiting');

    // var checkActivityId = null;
    // var checkActivity = function() {
    //   clearTimeout(checkActivityId);
    //   checkActivityId = setTimeout(function() {
    //
    //   }, 3 * 60 * 1000); // 3 mins
    // };
    //
    // checkActivity();
  },
  function (session, result) {
    // DB.lastActivityFromPlayerTakingPhoto = new Date().getTime();
    session.sendTyping();
    clarifai.models.predict(Clarifai.GENERAL_MODEL, result.response[0].contentUrl).then(
      function(response) {
        var tags = processTags(response.outputs[0].data.concepts.map(function(o) {return o.name;}));
        if (!tags.length) {
          session.send('Sorry, I could not identify anything in your photo. Try again');
          session.endDialog();
          session.beginDialog('/guessed');
        } else {
          DB.currentGameTagsTemp = tags;
          session.send('I see: ' + tags.join(', '));
          builder.Prompts.confirm(session, 'Is that correct?');
        }
      },
      function(err) {
        console.error(err);
        session.send('Error. Let\'s try again');
        session.endDialog();
        session.beginDialog('/guessed');
      }
    );
  },
  function (session, result) {
    // DB.lastActivityFromPlayerTakingPhoto = new Date().getTime();
    if (result.response) {
      // yes
      DB.playerTakingPhoto = null;
      DB.currentGameTags = DB.currentGameTagsTemp;
      DB.currentGameTagsTemp = null;

      var currentAddress = JSON.stringify(session.message.address);
      DB.currentGameSenderAddress = currentAddress;

      session.send('Awesome! I\'ll send that to everyone playing');
      session.endDialog();

      // notify other players
      DB.players.forEach(function(playerAddress) {
        if (!addressIsSameUser(playerAddress, currentAddress)) {
          var address = JSON.parse(playerAddress);
          var msg = new builder.Message().address(address).text('A new game has just started');
          bot.send(msg, function (err) { if (err) { console.error(err); } });
          bot.beginDialog(address, '/guess');
        }
      });
    } else {
      // no
      session.send('Ok. Let\'s try again.');
      session.endDialog();
      session.beginDialog('/guessed');
    }
  }
]);

//=========================================================
// Helpers
//=========================================================

function processTags(tags) {
  var removedTags = ['no person'];
  for (var i = 0; i < tags.length; i++) {
    if (removedTags.includes(tags[i])) {
      tags.splice(i, 1);
      i--;
    }
  }
  return tags.slice(0, 5);
}

function tagsMatch(arr1, arr2) {
  // at least one tag in common
  return !!arr1.find(function(t) { return arr2.indexOf(t) > -1; });
}

function addressIsSameUser(a1, a2) {
  a1 = JSON.parse(a1);
  a2 = JSON.parse(a2);
  return a1.user.id == a2.user.id;
}
