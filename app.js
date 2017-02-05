const WordPos = require('wordpos');
const Clarifai = require('clarifai');
const humanizeDuration = require('humanize-duration');
const localeEmoji = require('locale-emoji');
const superagent = require('superagent');
const builder = require('botbuilder');
const restify = require('restify');
const async = require('async');

// config
const TAGS_DISPLAYED = 3;
const TAGS_CONSIDERED = 5;
const WRONG_GUESSES_THRESHOLD = 3;
const INACTIVE_SNAPPER_TIMEOUT = 30 * 1000; // 30s

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
bot.use(builder.Middleware.dialogVersion({ version: 17.0, resetCommand: /^reset/i }));

// state
let playerTakingSnapTimeoutId = null;
let wrongGuesses = 0;

const STATE = {
  currentTags: null,
  currentSender: null,
  playerTakingSnap: null,
  gameStartedAt: null,
  snaps: [],
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
      const playersCount = Object.entries(STATE.players).length - 1; // exclude the current player

      // update lastActiveAt
      STATE.profiles[session.message.user.id].lastActiveAt = Date.now();

      if (STATE.currentSender && STATE.currentSender.user.id === session.message.address.user.id) {
        // this user is the current sender
        session.send('Hang on, ' + profile.first_name + '. ' +
          playersCount + ' players are trying to guess your snap 📷');
      } else {
        session.send('Hey, ' + profile.first_name + '! Let\'s play 🎮');
        if (!profile.hasLearnedIntro) {
          session.send('You\'ll receive an object description. Guess it by snapping a similar pic.' +
            'If you guess, you get to send the snap for others to guess! ☺️');
          profile.hasLearnedIntro = true;
        }
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
            // copy values into profile object
            STATE.profiles[session.message.address.user.id] = STATE.profiles[session.message.address.user.id] || {};
            Object.assign(STATE.profiles[session.message.address.user.id], res.body);
            contFlow();
          }
        });
    }
  },
]);

bot.dialog('/guess', [
  function(session) {
    // update lastActiveAt
    STATE.profiles[session.message.user.id].lastActiveAt = Date.now();

    if (STATE.currentTags && STATE.currentSender) { // game in progress
      session.sendTyping();
      session.sendBatch();
      const senderProfile = STATE.profiles[STATE.currentSender.user.id];
      session.send(senderProfile.first_name + ' ' + localeEmoji(senderProfile.locale) +
        ' took a snap that looks like: ' + displayTags(STATE.currentTags));
      builder.Prompts.attachment(session, 'Can you guess what it is? Take a similar snap 🔎');
    } else if (STATE.playerTakingSnap) { // somebody else is taking a snap
      const profile = STATE.profiles[STATE.playerTakingSnap.user.id];
      session.send(profile.first_name + ' ' + localeEmoji(profile.locale) + ' is taking a snap... 📷');
    } else {
      // ask to send snap
      session.replaceDialog('/snap');
    }
  },
  function(session, result) {
    session.sendTyping();
    session.sendBatch();

    // update lastActiveAt
    STATE.profiles[session.message.user.id].lastActiveAt = Date.now();

    clarifai.models.predict(Clarifai.GENERAL_MODEL, result.response[0].contentUrl).then(
      function(response) {
        processConcepts(response.outputs[0].data.concepts)
          .then((tags) => {
            console.log('tags from clarifai:', tags);

            if (!tags.length) {
              session.send('Sorry, I could not identify anything in your snap. Try again 🙏');
              session.replaceDialog('/guess');
            } else {
              const numMatches = tagMatches(STATE.currentTags, tags);

              // guessed
              if (numMatches >= 3) {
                STATE.snaps.push({
                  imageUrl: result.response[0].contentUrl,
                  uid: session.message.address.user.id,
                  tags: STATE.currentTags,
                  sentAt: Date.now(),
                });

                // calculate how long it took to guess
                const durationInMs = Date.now() - STATE.gameStartedAt;
                const durationStr = humanizeDuration(durationInMs, {largest: 2, round: true, delimiter: ' and '});

                // notify the author of the pic
                const currentProfile = STATE.profiles[session.message.address.user.id];
                const genderPron = currentProfile.gender === 'male' ? 'him' : 'her';

                const msgForAuthor = new builder.Message()
                  .address(STATE.currentSender)
                  .text(currentProfile.first_name + ' ' + localeEmoji(currentProfile.locale) +
                    ' guessed your snap! It took ' + genderPron + ' ' + durationStr + ' ⚡️');

                const card1 = STATE.snaps[STATE.snaps.length - 2];
                const card2 = STATE.snaps[STATE.snaps.length - 1];

                const compareSnapsMsgToAuthor = new builder.Message(session)
                  .address(STATE.currentSender)
                  .attachmentLayout(builder.AttachmentLayout.carousel)
                  .attachments([
                    new builder.HeroCard(session)
                      .title('Snapped by ' + STATE.profiles[card1.uid].first_name)
                      .subtitle(displayTags(card1.tags))
                      .images([builder.CardImage.create(session, card1.imageUrl)
                        .tap(builder.CardAction.showImage(session, card1.imageUrl))]),
                    new builder.HeroCard(session)
                      .title('Snapped by ' + STATE.profiles[card2.uid].first_name)
                      .subtitle(displayTags(card2.tags))
                      .images([builder.CardImage.create(session, card2.imageUrl)
                        .tap(builder.CardAction.showImage(session, card2.imageUrl))]),
                  ]);

                async.series([
                  async.apply(bot.send.bind(bot), msgForAuthor),
                  async.apply(bot.send.bind(bot), compareSnapsMsgToAuthor),
                ], function(err) { if (err) { console.error(err); } });

                // notify everyone else
                for (const [uid, address] of Object.entries(STATE.players)) {
                  if (uid !== session.message.address.user.id && uid !== STATE.currentSender.user.id) {
                    const msg1 = new builder.Message()
                      .address(address)
                      .text(currentProfile.first_name + ' ' + localeEmoji(currentProfile.locale) +
                        ' guessed the current snap.' + ' It took ' + genderPron + ' ' + durationStr + ' ⚡️');

                    const msg2 = new builder.Message(session)
                      .address(address)
                      .attachmentLayout(builder.AttachmentLayout.carousel)
                      .attachments([
                        new builder.HeroCard(session)
                          .title('Snapped by ' + STATE.profiles[card1.uid].first_name)
                          .subtitle(displayTags(card1.tags))
                          .images([builder.CardImage.create(session, card1.imageUrl)
                            .tap(builder.CardAction.showImage(session, card1.imageUrl))]),
                        new builder.HeroCard(session)
                          .title('Snapped by ' + STATE.profiles[card2.uid].first_name)
                          .subtitle(displayTags(card2.tags))
                          .images([builder.CardImage.create(session, card2.imageUrl)
                            .tap(builder.CardAction.showImage(session, card2.imageUrl))]),
                      ]);

                    const msg3 = new builder.Message()
                      .address(address)
                      .text('Hang on, now ' + currentProfile.first_name + ' ' +
                        localeEmoji(currentProfile.locale) + ' has to send a snap 📷');

                    async.series([
                      async.apply(bot.send.bind(bot), msg1),
                      async.apply(bot.send.bind(bot), msg2),
                      async.apply(bot.send.bind(bot), msg3),
                    ], function(err) { if (err) { console.error(err); } });
                  }
                }

                STATE.currentTags = null;
                STATE.currentSender = null;
                STATE.gameStartedAt = null;

                session.send('You guessed, yay! 🎊');
                const compareSnapsMsg = new builder.Message(session)
                  .attachmentLayout(builder.AttachmentLayout.carousel)
                  .attachments([
                    new builder.HeroCard(session)
                      .title('Snapped by ' + STATE.profiles[card1.uid].first_name)
                      .subtitle(displayTags(card1.tags))
                      .images([builder.CardImage.create(session, card1.imageUrl)
                        .tap(builder.CardAction.showImage(session, card1.imageUrl))]),
                    new builder.HeroCard(session)
                      .title('Snapped by ' + STATE.profiles[card2.uid].first_name)
                      .subtitle(displayTags(card2.tags))
                      .images([builder.CardImage.create(session, card2.imageUrl)
                        .tap(builder.CardAction.showImage(session, card2.imageUrl))]),
                  ]);
                session.send(compareSnapsMsg);
                session.send('It took you ' + durationStr + ' ⚡️');
                session.replaceDialog('/snap');
              }

              // choose another player, randomly
              const chooseAnotherPlayer = () => {
                // notify everyone
                for (const address of Object.values(STATE.players)) {
                  const msg = new builder.Message()
                    .address(address)
                    .text('Nobody won this round. I\'ll pick another player to take a snap...');
                  bot.send(msg);
                }

                const uid = randOf(Object.keys(STATE.players));
                bot.beginDialog(STATE.players[uid], '/snap');
              };

              if (numMatches === 2) {
                session.send('You\'re very close! 🔥🔥🔥');
                wrongGuesses++;
                if (wrongGuesses >= WRONG_GUESSES_THRESHOLD) {
                  chooseAnotherPlayer();
                } else {
                  session.replaceDialog('/guess');
                }
              }

              if (numMatches === 1) {
                session.send('No, but you\'re close 🔥🔥');
                wrongGuesses++;
                if (wrongGuesses >= WRONG_GUESSES_THRESHOLD) {
                  chooseAnotherPlayer();
                } else {
                  session.replaceDialog('/guess');
                }
              }

              if (numMatches < 1) {
                session.send('No, that\'s not it ' + randOf(['😞', '😔', '😟', '😕', '☹️', '🙁']));
                wrongGuesses++;
                if (wrongGuesses >= WRONG_GUESSES_THRESHOLD) {
                  chooseAnotherPlayer();
                } else {
                  session.replaceDialog('/guess');
                }
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

bot.dialog('/snap', [
  function(session) {
    STATE.playerTakingSnap = session.message.address;

    // update lastActiveAt
    STATE.profiles[session.message.user.id].lastActiveAt = Date.now();

    const setInactivityTimeout = () => {
      clearTimeout(playerTakingSnapTimeoutId);
      playerTakingSnapTimeoutId = setTimeout(function() {
        const currentProfile = STATE.profiles[session.message.address.user.id];
        const genderPos = currentProfile.gender === 'male' ? 'his' : 'her';

        console.log('running timeout checker for', session.message.address.user.id);
        console.log('last active:', Date.now() - currentProfile.lastActiveAt, 'ms ago');

        // if the user has been active lately, don't time out
        if (currentProfile.lastActiveAt && Date.now() - currentProfile.lastActiveAt < INACTIVE_SNAPPER_TIMEOUT) {
          setInactivityTimeout();
          return;
        }

        console.log('player taking snap', STATE.playerTakingSnap, 'lost their turn');
        const playerTakingSnap = STATE.playerTakingSnap;

        STATE.playerTakingSnap = null;
        session.send('Ops! You lost your turn. Next time, snap faster 💫');

        // announce the others about this user's failure
        for (const [uid, address] of Object.entries(STATE.players)) {
          if (uid !== session.message.address.user.id) {
            const msg1 = new builder.Message()
              .address(address)
              .text('Oh, no! ' + currentProfile.first_name + ' ' + localeEmoji(currentProfile.locale) +
                ' lost ' + genderPos + ' turn');

            async.series([
              async.apply(bot.send.bind(bot), msg1),
            ], function(err) {
              if (err) {
                console.error(err);
              }
              bot.beginDialog(address, '/guess');
            });
          }
        }

        // delay switch
        setTimeout(function() {
          bot.beginDialog(playerTakingSnap, '/guess');
        }, 3000); // 3s
      }, INACTIVE_SNAPPER_TIMEOUT);
    };

    setInactivityTimeout();

    session.sendTyping();
    session.sendBatch();
    session.send('Now it\'s your turn to take a snap. I\'ll ask the other players to guess it!');
    builder.Prompts.attachment(session, 'Use the Messenger camera to send me a photo 📷');
  },
  function(session, result) {
    session.sendTyping();
    session.sendBatch();

    // user is not snapping anymore
    if (!STATE.playerTakingSnap) {
      return;
    }

    // update lastActiveAt
    STATE.profiles[session.message.user.id].lastActiveAt = Date.now();

    clarifai.models.predict(Clarifai.GENERAL_MODEL, result.response[0].contentUrl).then(
      function(response) {
        processConcepts(response.outputs[0].data.concepts)
          .then((tags) => {
            console.log('tags from clarifai:', tags);

            // user is not snapping anymore
            if (!STATE.playerTakingSnap) {
              return;
            }

            if (!tags.length) {
              session.send('Sorry, I could not identify anything in your snap. Try again 🙏');
              session.replaceDialog('/snap');
            } else {
              session.userData.currentTags = tags;
              session.userData.imageUrl = result.response[0].contentUrl;
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
        session.replaceDialog('/snap');
      }
    );
  },
  function(session, result) {
    // update lastActiveAt
    STATE.profiles[session.message.user.id].lastActiveAt = Date.now();

    // user is not snapping anymore
    if (!STATE.playerTakingSnap) {
      return;
    }

    // check response
    if (result.response.index === 0) {
      // yes
      session.sendTyping();
      session.sendBatch();

      // clear sender inactivity timeout
      clearTimeout(playerTakingSnapTimeoutId);

      STATE.currentTags = session.userData.currentTags;
      STATE.snaps.push({
        imageUrl: session.userData.imageUrl,
        uid: session.message.address.user.id,
        tags: session.userData.currentTags,
        sentAt: Date.now(),
      });

      STATE.playerTakingSnap = null;
      STATE.currentSender = session.message.address;
      STATE.gameStartedAt = Date.now();

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
      session.send('Ok. Let\'s try again 👍');
      session.replaceDialog('/snap');
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
        .slice(0, TAGS_CONSIDERED);
    });
}

// prepare for display
function displayTags(tags) {
  const excludedTags = ['no person'];
  const newTags = [];

  // filter
  for (const tag of tags) {
    if (!excludedTags.includes(tag)) {
      newTags.push(tag);
    }
  }

  return newTags.slice(0, TAGS_DISPLAYED).join(', ');
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

function getRandomInt(min, max) {
  min = Math.ceil(min);
  max = Math.floor(max);
  return Math.floor(Math.random() * (max - min)) + min;
}

function randOf(arr) {
  return arr[getRandomInt(0, arr.length)];
}
