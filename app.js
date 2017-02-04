const Clarifai = require('clarifai');
const builder = require('botbuilder');
const restify = require('restify');

// Instantiate a new Clarifai app
const clarifai = new Clarifai.App(
  process.env.CLARIFAI_CLIENTID,
  process.env.CLARIFAI_SECRET
);

// Setup Restify Server
const server = restify.createServer();
server.listen(process.env.port || process.env.PORT || 3978, function() {
  console.log('%s listening to %s', server.name, server.url);
});

// Create chat bot
const connector = new builder.ChatConnector({
  appId: process.env.MICROSOFT_APP_ID,
  appPassword: process.env.MICROSOFT_APP_PASSWORD,
});
const bot = new builder.UniversalBot(connector);
server.post('/api/messages', connector.listen());

// Anytime the major version is incremented any existing conversations will be restarted.
bot.use(builder.Middleware.dialogVersion({ version: 1.0, resetCommand: /^reset/i }));

const STATE = {
  currentTags: null,
  currentSender: null,
  playerTakingPhoto: null,
  players: {},
};

bot.dialog('/', [
  function(session) {
    STATE.players[session.message.address.user.id] = session.message.address;
    session.sendTyping();
    session.sendBatch();

    if (STATE.currentSender.user.id === session.message.address.user.id) {
      // this user is the current sender
      session.send('Hang on, someone has to guess your photo');
    } else {
      session.send('Hey, let\'s play!');
      session.beginDialog('/guess');
    }
  },
]);

bot.dialog('/guess', [
  function(session) {
    if (STATE.currentTags) { // game in progress
      session.sendTyping();
      session.sendBatch();
      builder.Prompts.attachment(session, 'Send me a photo that looks like: ' + displayTags(STATE.currentTags));
    } else if (STATE.playerTakingPhoto) { // somebody else is taking a photo
      session.send('Please wait, the game is starting');
    } else {
      // ask to send photo
      session.replaceDialog('/guessed');
    }
  },
  function(session, result) {
    session.sendTyping();
    session.sendBatch();

    clarifai.models.predict(Clarifai.GENERAL_MODEL, result.response[0].contentUrl).then(
      function(response) {
        const tags = processConcepts(response.outputs[0].data.concepts);
        if (!tags.length) {
          session.send('Sorry, I could not identify anything in your photo. Try again');
          session.replaceDialog('/guess');
        } else if (tagsMatch(STATE.currentTags, tags)) {
          // notify the author of the pic
          const msg = new builder.Message().address(STATE.currentSender).text('Somebody guessed your image!');
          bot.send(msg, function(err) { if (err) { console.error(err); } });

          // notify everyone else
          for (const [uid, address] of Object.entries(STATE.players)) {
            if (uid !== session.message.address.user.id && uid !== STATE.currentSender.user.id) {
              const msg1 = new builder.Message().address(address).text('Somebody guessed the current photo');
              const msg2 = new builder.Message().address(address).text('Hang on, now they have to send an image');
              bot.send(msg1, function(err) {
                if (err) {
                  console.error(err);
                }

                bot.send(msg2, function(err) { if (err) { console.error(err); } });
              });
            }
          }

          session.send('You guessed, yay! 🎊');
          session.replaceDialog('/guessed');
        } else {
          session.send('No, that\'s not it');
          session.replaceDialog('/guess');
        }
      },
      function(err) {
        console.error(err);
        session.send('Error. Let\'s try again');
        session.replaceDialog('/guess');
      }
    );
  },
]);

bot.dialog('/guessed', [
  function(session) {
    STATE.playerTakingPhoto = session.message.address;
    session.sendTyping();
    session.sendBatch();
    session.send('Now it\'s your turn to take a photo. I\'ll ask everyone else playing the game to guess!');
    builder.Prompts.attachment(session, 'Go ahead, I\'m waiting');
  },
  function(session, result) {
    session.sendTyping();
    session.sendBatch();
    clarifai.models.predict(Clarifai.GENERAL_MODEL, result.response[0].contentUrl).then(
      function(response) {
        const tags = processConcepts(response.outputs[0].data.concepts);
        if (!tags.length) {
          session.send('Sorry, I could not identify anything in your photo. Try again');
          session.replaceDialog('/guessed');
        } else {
          STATE.currentTags = tags;
          session.send('I see: ' + displayTags(tags));
          builder.Prompts.confirm(session, 'Is that correct?');
        }
      },
      function(err) {
        console.error(err);
        session.send('Error. Let\'s try again');
        session.replaceDialog('/guessed');
      }
    );
  },
  function(session, result) {
    if (result.response) {
      // yes
      session.sendTyping();
      session.sendBatch();

      STATE.playerTakingPhoto = null;
      STATE.currentSender = session.message.address;

      session.send('Awesome! I\'ll send that to everyone playing');
      session.endDialog();

      // notify other players
      for (const [uid, address] of Object.entries(STATE.players)) {
        if (uid !== session.message.address.user.id) {
          const msg = new builder.Message().address(address).text('A new game has just started');
          bot.send(msg, function(err) { if (err) { console.error(err); } });
          bot.beginDialog(address, '/guess');
        }
      }
    } else {
      // no
      session.send('Ok. Let\'s try again.');
      session.replaceDialog('/guessed');
    }
  },
]);

// process tags before storing
function processConcepts(concepts) {
  return concepts.map((o) => o.name).slice(0, 5);
}

// prepare for display
function displayTags(tags) {
  const removedTags = ['no person'];
  const newTags = [];

  // filter
  for (const tag of tags) {
    if (!removedTags.includes(tag)) {
      newTags.push(tag);
    }
  }

  return newTags.slice(0, 3).join(', ');
}

function tagsMatch(arr1, arr2) {
  let numMatches = 0;

  // count elements in both arrays
  for (const e1 of arr1) {
    if (arr2.includes(e1)) {
      numMatches++;
    }
  }

  return numMatches >= 3;
}
