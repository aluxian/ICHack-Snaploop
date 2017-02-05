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

// create a POS classifier
const wordpos = new WordPos();

// instantiate a new Clarifai app
const clarifai = new Clarifai.App(
  process.env.CLARIFAI_CLIENTID,
  process.env.CLARIFAI_SECRET
);

// setup Restify Server
const server = restify.createServer();
server.listen(process.env.port || process.env.PORT || 3978, function() {
  console.info('%s listening to %s', server.name, server.url);
});

// create chat bot
const connector = new builder.ChatConnector({
  appId: process.env.MICROSOFT_APP_ID,
  appPassword: process.env.MICROSOFT_APP_PASSWORD,
});
const bot = new builder.UniversalBot(connector);
server.post('/api/messages', connector.listen());

// state
const STATE = {
  currentTags: null,
  currentSender: null,
  playerTakingSnap: null,
  wrongGuesses: 0,
  snaps: {
    original: null,
    final: null,
  },
  players: {},
  profiles: {},
};

// install middleware
bot.use(builder.Middleware.dialogVersion({ version: 18.0, resetCommand: /^reset/i }));
bot.use(storePlayerMiddleware());
bot.use(storeLatestActivityMiddleware());
bot.use(sendTypingMiddleware());

// check for inactivity
setInterval(function() {
  if (!STATE.playerTakingSnap) {
    return;
  }

  const snapperProfile = STATE.profiles[STATE.playerTakingSnap.user.id];
  const senderGenderPos = snapperProfile.gender === 'male' ? 'his' : 'her';

  console.log('running timeout checker for', STATE.playerTakingSnap.user.id);
  console.log('last active:', snapperProfile.lastActiveAt && new Date(snapperProfile.lastActiveAt) || null);

  // if the user has been active lately, don't time them out
  if (!snapperProfile.lastActiveAt || Date.now() - snapperProfile.lastActiveAt < INACTIVE_SNAPPER_TIMEOUT) {
    return;
  }

  // announce everyone about this user's failure (including the user)
  for (const [uid, address] of getActivePlayers()) {
    console.log('announcing', uid, 'about failure');

    const textMessage = uid === STATE.playerTakingSnap.user.id
      ? 'Ops! You lost your turn. Next time, snap faster 💫'
      : 'Oh, no! ' + snapperProfile.first_name + ' ' + localeEmoji(snapperProfile.locale) +
        ' lost ' + senderGenderPos + ' turn';

    console.log('sending', textMessage, 'to', address);
    bot.send(
      new builder.Message()
        .address(address)
        .text(textMessage),
      (err) => {
        if (err) {
          console.error(err);
        }
        bot.beginDialog(address, '/guess'); // TODO check this
      }
    );
  }

  STATE.playerTakingSnap = null;
}, 5 * 1000); // 5s

// set dialogs
bot.dialog('/', [
  // handle profile
  function(session, args, next) {
    const uid = session.message.address.user.id;
    if (STATE.profiles[uid].__hasFB) {
      // has profile data already
      next();
    } else {
      // need to get profile data from facebook
      console.log('getting profile from Graph API for', uid);
      getFbProfile(uid, (err, res) => {
        if (err || !res.ok) {
          console.error(err || 'ERR: status code not ok');
          session.send('Error 🚨');
          session.endDialog();
        } else {
          // copy values into profile object
          STATE.profiles[uid] = STATE.profiles[uid] || {};
          Object.assign(STATE.profiles[uid], res.body);
          STATE.profiles[uid].__hasFB = true;
          next();
        }
      });
    }
  },
  // handle intro
  function(session) {
    const profile = STATE.profiles[session.message.address.user.id];
    if (STATE.currentSender && STATE.currentSender.user.id === session.message.address.user.id) {
      // this user is the current sender
      const playersCount = getActivePlayers({excl: session.message.address}).length;
      const extraPl = playersCount === 1 ? ' is' : 's are';
      session.send('Hang on, ' + profile.first_name + '. ' +
        playersCount + ' player' + extraPl + ' trying to guess your snap 📷');
      session.endDialog();
    } else {
      // introduce the user to the game
      session.send('Hey, ' + profile.first_name + '! Let\'s play 🎮');

      // teach them quick tips about the game, just once
      if (!profile.hasLearnedIntro) {
        session.send('You\'ll receive an object description. Guess it by snapping a similar pic. ' +
          'If you guess, you get to send the next snap! ☺️');
        profile.hasLearnedIntro = true;
      }

      session.replaceDialog('/guess');
    }
  },
]);

bot.dialog('/guess', [
  // handle receiving guess
  function(session) {
    if (STATE.currentTags && STATE.currentSender) {
      // game in progress
      const senderProfile = STATE.profiles[STATE.currentSender.user.id];
      session.send(senderProfile.first_name + ' ' + localeEmoji(senderProfile.locale) +
        ' took a snap that looks like: ' + displayTags(STATE.currentTags));
      builder.Prompts.attachment(session, 'Can you guess what it is? Take a similar snap 🔎');
    } else if (STATE.playerTakingSnap) {
      // somebody else is taking a snap
      const snapperProfile = STATE.profiles[STATE.playerTakingSnap.user.id];
      session.send(snapperProfile.first_name + ' ' + localeEmoji(snapperProfile.locale) + ' is taking a snap... 📷');
      session.endDialog();
    } else {
      // ask to send snap
      session.send('Now it\'s your turn to take a snap');
      session.replaceDialog('/snap');
    }
  },
  // handle when user tries to guess with their image
  function(session, result) {
    analyseImage(result.response[0].contentUrl, (err, tags) => {
      if (err) {
        console.error(err);
        session.send('Error. Let\'s try again 🙏');
        session.replaceDialog('/guess');
        return;
      }

      console.log('tags from clarifai trying to guess final:', tags);
      if (!tags.length) {
        session.send('Sorry, I could not identify anything in your snap. Try again 🙏');
        session.replaceDialog('/guess');
        return;
      }

      const numMatches = tagMatches(STATE.currentTags, tags);
      console.log('tags that match:', numMatches);

      if (numMatches >= 3) {
        // save final image
        STATE.snaps.final = {
          imageUrl: result.response[0].contentUrl,
          uid: session.message.address.user.id,
          tags: STATE.currentTags,
          sentAt: Date.now(),
        };

        // calculate how long it took to guess
        const durationInMs = Date.now() - STATE.snaps.original.sentAt;
        const durationStr = humanizeDuration(durationInMs, {largest: 2, round: true, delimiter: ' and '});

        // notify the author of the snap
        const currentProfile = STATE.profiles[session.message.address.user.id];
        const currentGenderPron = currentProfile.gender === 'male' ? 'him' : 'her';
        const currentGenderPos = currentProfile.gender === 'male' ? 'his' : 'her';

        const msgForAuthor1 = new builder.Message()
          .address(STATE.currentSender)
          .text(currentProfile.first_name + ' ' + localeEmoji(currentProfile.locale) +
            ' guessed your snap! It took ' + currentGenderPron + ' ' + durationStr + ' ⚡️');
        const msgForAuthor2 = new builder.Message()
          .address(STATE.currentSender)
          .text('Now it\'s ' + currentGenderPos + ' turn to take a snap... 📷');
        const compareSnapsMsgToAuthor = new builder.Message(session)
          .address(STATE.currentSender)
          .attachmentLayout(builder.AttachmentLayout.carousel)
          .attachments([
            snapToHeroCard(session, STATE.snaps.original),
            snapToHeroCard(session, STATE.snaps.final),
          ]);

        async.series([
          async.apply(bot.send.bind(bot), msgForAuthor1),
          async.apply(bot.send.bind(bot), compareSnapsMsgToAuthor),
          async.apply(bot.send.bind(bot), msgForAuthor2),
        ], function(err) { if (err) { console.error(err); } });

        // notify everyone else (excluding current user and sender)
        for (const [uid, address] of getActivePlayers({excl: session.message.address})) {
          if (uid === STATE.currentSender.user.id) {
            // exclude sender
            return;
          }

          const msg1 = new builder.Message()
            .address(address)
            .text(currentProfile.first_name + ' ' + localeEmoji(currentProfile.locale) +
              ' guessed the current snap.' + ' It took ' + currentGenderPron + ' ' + durationStr + ' ⚡️');
          const msg2 = new builder.Message(session)
            .address(address)
            .attachmentLayout(builder.AttachmentLayout.carousel)
            .attachments([
              snapToHeroCard(session, STATE.snaps.original),
              snapToHeroCard(session, STATE.snaps.final),
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

        // clear data
        STATE.currentTags = null;
        STATE.currentSender = null;

        // notify user
        session.send('You guessed, yay! 🎊');
        const compareSnapsMsg = new builder.Message(session)
          .attachmentLayout(builder.AttachmentLayout.carousel)
          .attachments([
            snapToHeroCard(session, STATE.snaps.original),
            snapToHeroCard(session, STATE.snaps.final),
          ]);
        session.send(compareSnapsMsg);
        session.send('It took you ' + durationStr + ' ⚡️');
        session.replaceDialog('/snap');
      }

      // choose another player, randomly
      const chooseAnotherPlayer = () => {
        // notify everyone
        for (const [uid, address] of getActivePlayers()) {
          console.log('notifying', uid, 'that nobody won this round');
          bot.send(new builder.Message()
            .address(address)
            .text('Nobody won this round. I\'ll pick another player to take a snap...'));
        }

        // choose next random person
        setTimeout(function() {
          const entry = randOf(getActivePlayers());
          bot.beginDialog(entry[1], '/snap');
        }, 2 * 1000); // 2s
      };

      // handle match
      const handleCloseMatch = (num, text) => {
        if (numMatches === num) {
          session.send(text);
          STATE.wrongGuesses++;
          if (STATE.wrongGuesses >= WRONG_GUESSES_THRESHOLD) {
            setTimeout(function() {
              STATE.wrongGuesses = 0;
              chooseAnotherPlayer();
            }, 2000);
          } else {
            session.replaceDialog('/guess');
          }
        }
      };

      handleCloseMatch(2, 'You\'re very close! 🔥🔥🔥');
      handleCloseMatch(1, 'No, but you\'re close 🔥🔥');
      handleCloseMatch(0, 'No, that\'s not it ' + randOf(['😞', '😔', '😟', '😕', '☹️', '🙁']));
    });
  },
]);

bot.dialog('/snap', [
  // main instruction
  function(session) {
    STATE.playerTakingSnap = session.message.address;
    builder.Prompts.attachment(session, 'Use the Messenger camera to send me a photo 📷');
  },
  // analyse the image
  function(session, result) {
    analyseImage(result.response[0].contentUrl, (err, tags) => {
      if (err) {
        console.error(err);
        session.send('Error. Let\'s try again 🚨');
        session.replaceDialog('/snap');
        return;
      }

      // no tags case
      console.log('tags from clarifai:', tags);
      if (!tags.length) {
        session.send('Sorry, I could not identify anything in your snap. Try again 🙏');
        session.replaceDialog('/snap');
        return;
      }

      // save tags and image url
      session.userData.currentTags = tags;
      session.userData.imageUrl = result.response[0].contentUrl;

      // ask for confirmation
      session.send('I see: ' + displayTags(tags));
      builder.Prompts.choice(session, 'Is that correct?', ['Yes, send ✅', 'No, retake ❌']);
    });
  },
  // handle confirmation
  function(session, result) {
    // check response
    if (result.response.index === 0) { // yes
      // persist data
      STATE.currentTags = session.userData.currentTags;
      STATE.snaps.original = {
        imageUrl: session.userData.imageUrl,
        uid: session.message.address.user.id,
        tags: session.userData.currentTags,
        sentAt: Date.now(),
      };
      STATE.playerTakingSnap = null;
      STATE.currentSender = session.message.address;

      // notify other players
      let playersCount = 0;
      for (const [uid, address] of getActivePlayers()) {
        if (uid !== session.message.address.user.id) {
          bot.beginDialog(address, '/guess'); // TODO when is the prev one ended?
          playersCount++;
        }
      }

      // notify the snapper
      const extraPl = playersCount === 1 ? '' : 's';
      session.send('Awesome! I sent that to ' + playersCount + ' player' + extraPl);
      session.endDialog();
    } else { // no
      session.send('Ok. Let\'s try again 👍');
      session.replaceDialog('/snap');
    }
  },
]);

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

function getActivePlayers(opts = {}) {
  if (opts.excl) { // exclude the user with this address
    return Object.entries(STATE.players)
      .filter((entry) => entry[1].user.id !== opts.excl.user.id);
  }

  return Object.entries(STATE.players);
}

function snapToHeroCard(session, snap) {
  return new builder.HeroCard(session)
    .title('Snapped by ' + STATE.profiles[snap.uid].first_name)
    .subtitle(displayTags(snap.tags))
    .images([builder.CardImage.create(session, snap.imageUrl)]);
}

function getFbProfile(userId, cb) {
  const fields = [
    'first_name',
    'last_name',
    'profile_pic',
    'gender',
    'locale',
    'timezone',
  ];

  superagent
    .get('https://graph.facebook.com/v2.8/' + userId)
    .set('Accept', 'application/json')
    .set('Content-Type', 'application/json')
    .set('User-Agent', 'bot')
    .query({
      access_token: process.env.FACEBOOK_ACCESS_TOKEN,
      fields: fields.join(','),
    })
    .end(cb);
}

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

function analyseImage(imageUrl, cb) {
  clarifai.models.predict(Clarifai.GENERAL_MODEL, imageUrl)
    .then((response) => processConcepts(response.outputs[0].data.concepts))
    .then((tags) => cb(null, tags))
    .catch((err) => cb(err));
}

function storePlayerMiddleware() {
  return {
    botbuilder: function(session, next) {
      STATE.players[session.message.address.user.id] = session.message.address;
      next();
    },
  };
}

function storeLatestActivityMiddleware() {
  return {
    botbuilder: function(session, next) {
      const uid = session.message.address.user.id;
      STATE.profiles[uid] = STATE.profiles[uid] || {};
      STATE.profiles[uid].lastActiveAt = Date.now();
      console.log('user', uid, 'lastActiveAt', new Date(STATE.profiles[uid].lastActiveAt));
      next();
    },
  };
}

function sendTypingMiddleware() {
  return {
    botbuilder: function(session, next) {
      session.sendTyping();
      session.sendBatch();
      next();
    },
  };
}
