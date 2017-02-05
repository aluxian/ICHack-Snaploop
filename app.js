const WordPos = require('wordpos');
const Clarifai = require('clarifai');
const humanizeDuration = require('humanize-duration');
const superagent = require('superagent');
const builder = require('botbuilder');
const restify = require('restify');

// Create a POS classifier
const wordpos = new WordPos();

// Instantiate a new Clarifai app
const clarifai = new Clarifai.App(
  process.env.CLARIFAI_CLIENTID,
  process.env.CLARIFAI_SECRET
);

// Setup Restify Server
const server = restify.createServer();
server.listen(process.env.port || process.env.PORT || 3978, function() {
  console.info('%s listening to %s', server.name, server.url);
});

// Create chat bot
const connector = new builder.ChatConnector({
  appId: process.env.MICROSOFT_APP_ID,
  appPassword: process.env.MICROSOFT_APP_PASSWORD,
});
const bot = new builder.UniversalBot(connector);
server.post('/api/messages', connector.listen());

// Anytime the major version is incremented any existing conversations will be restarted.
bot.use(builder.Middleware.dialogVersion({ version: 10.0, resetCommand: /^reset/i }));

const STATE = {
  currentTags: null,
  currentSender: null,
  playerTakingSnap: null,
  gameStartedAt: null,
  players: {},
  profiles: {},
};

bot.dialog('/', [
  function(session) {
    STATE.players[session.message.address.user.id] = session.message.address;
    session.sendTyping();
    session.sendBatch();

    const contFlow = () => {
      const profile = STATE.profiles[session.message.address.user.id];
      if (STATE.currentSender && STATE.currentSender.user.id === session.message.address.user.id) {
        // this user is the current sender
        session.send('Hang on, ' + profile.first_name + '. ' +
          countOtherPlayers() + ' players are trying to guess your snap');
      } else {
        session.send('Hey, ' + profile.first_name + '! Let\'s play 🎮');
        session.beginDialog('/guess');
      }
    };

    if (STATE.profiles[session.message.address.user.id]) {
      contFlow();
    } else {
      const fields = [
        'first_name',
        'last_name',
        'profile_pic',
        'gender',
        'locale',
        'timezone',
      ];

      superagent
        .get('https://graph.facebook.com/v2.8/' + session.message.address.user.id)
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .set('User-Agent', 'bot')
        .query({
          access_token: process.env.FACEBOOK_ACCESS_TOKEN,
          fields: fields.join(','),
        })
        .end(function(err, res) {
          if (err || !res.ok) {
            console.error(err);
            session.send('Error 🚨');
          } else {
            STATE.profiles[session.message.address.user.id] = res.body;
            contFlow();
          }
        });
    }
  },
]);

bot.dialog('/guess', [
  function(session) {
    if (STATE.currentTags && STATE.currentSender) { // game in progress
      session.sendTyping();
      session.sendBatch();
      const senderProfile = STATE.profiles[STATE.currentSender.user.id];
      session.send(senderProfile.first_name + ' took a snap that looks like: ' + displayTags(STATE.currentTags));
      builder.Prompts.attachment(session, 'Can you guess what it is? 　');
    } else if (STATE.playerTakingSnap) { // somebody else is taking a snap
      const profile = STATE.profiles[STATE.playerTakingSnap.user.id];
      session.send('Please wait, ' + profile.first_name + ' is taking a snap 📷');
    } else {
      // ask to send snap
      session.replaceDialog('/guessed');
    }
  },
  function(session, result) {
    session.sendTyping();
    session.sendBatch();

    clarifai.models.predict(Clarifai.GENERAL_MODEL, result.response[0].contentUrl).then(
      function(response) {
        processConcepts(response.outputs[0].data.concepts)
          .then((tags) => {
            if (!tags.length) {
              session.send('Sorry, I could not identify anything in your snap. Try again 🙏');
              session.replaceDialog('/guess');
            } else {
              const numMatches = tagMatches(STATE.currentTags, tags);

              // guessed
              if (numMatches >= 3) {
                const durationInMs = new Date().getTime() - STATE.gameStartedAt.getTime();
                const durationStr = humanizeDuration(durationInMs, {largest: 2, round: true, delimiter: ' and '});

                // notify the author of the pic
                const currentProfile = STATE.profiles[session.message.address.user.id];
                const genderPron = currentProfile.gender === 'male' ? 'him' : 'her';
                const msg = new builder.Message()
                  .address(STATE.currentSender)
                  .text(currentProfile.first_name + ' guessed your snap! It took ' +
                    genderPron + ' ' + durationStr + ' ⚡️');
                bot.send(msg, function(err) { if (err) { console.error(err); } });

                // notify everyone else
                for (const [uid, address] of Object.entries(STATE.players)) {
                  if (uid !== session.message.address.user.id && uid !== STATE.currentSender.user.id) {
                    const msg1 = new builder.Message()
                      .address(address)
                      .text(currentProfile.first_name + ' guessed the current snap.' +
                        ' It took ' + genderPron + ' ' + durationStr + ' ⚡️');
                    const msg2 = new builder.Message()
                      .address(address)
                      .text('Hang on, now ' + currentProfile.first_name + ' has to send a snap 📷');
                    bot.send(msg1, function(err) {
                      if (err) {
                        console.error(err);
                      }

                      bot.send(msg2, function(err) { if (err) { console.error(err); } });
                    });
                  }
                }

                STATE.currentTags = null;
                STATE.currentSender = null;
                STATE.gameStartedAt = null;

                session.send('You guessed, yay! 🎊');
                session.send('It took you ' + durationStr + ' ⚡️');
                session.replaceDialog('/guessed');
              }

              if (numMatches === 2) {
                session.send('You\'re very close! 🔥🔥🔥');
                session.replaceDialog('/guess');
              }

              if (numMatches === 1) {
                session.send('No, but you\'re close 🔥🔥');
                session.replaceDialog('/guess');
              }

              if (numMatches < 1) {
                session.send('No, that\'s not it ' + randOf(['　', '　', '　', '　']));
                session.replaceDialog('/guess');
              }
            }
          })
          .catch((err) => {
            console.error(err);
          });
      },
      function(err) {
        console.error(err);
        session.send('Error. Let\'s try again 🙏');
        session.replaceDialog('/guess');
      }
    );
  },
]);

bot.dialog('/guessed', [
  function(session) {
    STATE.playerTakingSnap = session.message.address;
    session.sendTyping();
    session.sendBatch();
    session.send('Now it\'s your turn to take a snap. I\'ll ask ' + countOtherPlayers() + ' players to guess!');
    builder.Prompts.attachment(session, 'Use the Messenger camera to send me a photo 📷');
  },
  function(session, result) {
    session.sendTyping();
    session.sendBatch();
    clarifai.models.predict(Clarifai.GENERAL_MODEL, result.response[0].contentUrl).then(
      function(response) {
        processConcepts(response.outputs[0].data.concepts)
          .then((tags) => {
            if (!tags.length) {
              session.send('Sorry, I could not identify anything in your snap. Try again 🙏');
              session.replaceDialog('/guessed');
            } else {
              STATE.currentTags = tags;
              session.send('I see: ' + displayTags(tags));
              builder.Prompts.choice(session, 'Is that correct?', ['Yes ✅', 'No ❌']);
            }
          })
          .catch((err) => {
            console.error(err);
          });
      },
      function(err) {
        console.error(err);
        session.send('Error. Let\'s try again 🚨');
        session.replaceDialog('/guessed');
      }
    );
  },
  function(session, result) {
    if (result.response.index === 0) {
      // yes
      session.sendTyping();
      session.sendBatch();

      STATE.playerTakingSnap = null;
      STATE.currentSender = session.message.address;
      STATE.gameStartedAt = new Date();

      // notify other players
      let playersCount = 0;
      for (const [uid, address] of Object.entries(STATE.players)) {
        if (uid !== session.message.address.user.id) {
          bot.beginDialog(address, '/guess');
          playersCount++;
        }
      }

      session.send('Awesome! I sent that to ' + playersCount + ' players');
      session.endDialog();
    } else {
      // no
      session.send('Ok. Let\'s try again.');
      session.replaceDialog('/guessed');
    }
  },
]);

// process tags before storing
function processConcepts(concepts) {
  const tags = concepts.map((concept) => concept.name);
  return Promise.all(tags.map((tag) => wordpos.isNoun(tag)))
    .then((results) => {
      const tagIsNounPairs = [];
      for (let i = 0; i < tags.length; i++) {
        tagIsNounPairs.push([tags[i], results[i]]);
      }

      return tagIsNounPairs
        .filter((pair) => pair[1])
        .map((pair) => pair[0])
        .slice(0, 7);
    });
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

  return newTags.slice(0, 5).join(', ');
}

function tagMatches(arr1, arr2) {
  if (!arr1 || !arr2) {
    return false;
  }

  let numMatches = 0;

  // count elements in both arrays
  for (const e1 of arr1) {
    if (arr2.includes(e1)) {
      numMatches++;
    }
  }

  return numMatches;
}

function countOtherPlayers() {
  return Object.entries(STATE.players).length - 1; // exclude the current player
}

function getRandomInt(min, max) {
  min = Math.ceil(min);
  max = Math.floor(max);
  return Math.floor(Math.random() * (max - min)) + min;
}

function randOf(arr) {
  return arr[getRandomInt(0, arr.length)];
}
