require('dotenv').config();
const { Telegraf } = require('telegraf');
const LocalSession = require('telegraf-session-local');
const db = require('./database');


const bot = new Telegraf(process.env.BOT_TOKEN);

bot.use((new LocalSession({ database: 'session_db.json' })).middleware());

bot.start((ctx) => {
  ctx.reply("Welcome. Type /new to submit donation.");
});

bot.command('new', (ctx) => {
  ctx.session.step = 'name';
  ctx.session.donation = {};
  ctx.reply("Enter Donor Name:");
});

bot.on('text', (ctx) => {
  if (!ctx.session.step) return;

  const steps = {
    name: {
      field: 'name',
      nextStep: 'phone',
      prompt: 'Enter Phone Number:'
    },
    phone: {
      field: 'phone',
      nextStep: 'place',
      prompt: 'Enter Place:'
    },
    place: {
      field: 'place',
      nextStep: 'amount',
      prompt: 'Enter Amount:'
    },
    amount: {
      field: 'amount',
      nextStep: 'screenshot',
      prompt: 'Upload Screenshot of Payment:'
    }
  };

  const currentStep = steps[ctx.session.step];
  if (currentStep) {
    ctx.session.donation[currentStep.field] = ctx.message.text;
    ctx.session.step = currentStep.nextStep;
    ctx.reply(currentStep.prompt);
  }
});

bot.on('text', (ctx) => {
  if (ctx.session.step === 'screenshot') {
    return ctx.reply('Please upload the screenshot image.');
  }
});

bot.on('photo', (ctx) => {
  if (ctx.session.step !== 'screenshot') return;

  const photo = ctx.message.photo.pop();
  ctx.session.donation.screenshot_file_id = photo.file_id;

  const amount = parseFloat(ctx.session.donation.amount);
  ctx.session.donation.status = amount >= 10000 ? 'needs_verification' : 'auto_eligible';

  db.run(
    `INSERT INTO donations (name, phone, place, amount, screenshot_file_id, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      ctx.session.donation.name,
      ctx.session.donation.phone,
      ctx.session.donation.place,
      amount,
      ctx.session.donation.screenshot_file_id,
      ctx.session.donation.status
    ],
    function (err) {
      if (err) {
        console.error(err);
        return ctx.reply('Error saving donation.');
      }

      console.log('Saved donation ID:', this.lastID);
      ctx.reply('Donation recorded successfully ✅');
      ctx.session.step = null;
    }
  );
});

bot.launch();

console.log('Bot started...');