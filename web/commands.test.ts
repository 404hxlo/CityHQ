// What Home's command box understands from plain words. Node runs this TypeScript directly.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Player } from './src/api.ts';
import {
  banHoursFrom, findNamed, findPlayer, firstNumber, githubUrlFrom, keepCase, matchActions, minutesFrom, normalize, reasonFrom,
  timeFrom, VOCABULARY, weatherFrom,
} from './src/commands.ts';

const top = (text: string) => matchActions(VOCABULARY, text)[0];

const PLAYERS = [
  { id: 3, name: 'tbriggs', ping: 47, character: 'Tommy Briggs' },
  { id: 7, name: 'LenaO', ping: 38, character: 'Lena Ortiz' },
  { id: 12, name: 'Kai', ping: 49, character: 'Kai Nakamura' },
  { id: 15, name: 'tomz', ping: 70, character: 'Tom Zane' },
] as Player[];

test('plain words find the action someone means', () => {
  const cases: [string, string][] = [
    ['announce car meet at 8', 'announce'],
    ['tell everyone the car meet starts at 8', 'announce'],
    ['say restart in 5', 'announce'],
    ['who is online', 'players'],
    ['players', 'players'],
    ['kick tommy for spamming', 'kick'],
    ['kick a player', 'kick'],
    ['ban kai 1 day', 'ban'],
    ['revive everyone', 'revive'],
    ['heal lena', 'heal'],
    ['give lena bandage 5', 'give'],
    ['give car adder', 'car'],
    ['spawn a car', 'car'],
    ['fix car tommy', 'fixcar'],
    ['tell tommy please read the rules', 'message'],
    ['make it rain', 'weather'],
    ['weather snow', 'weather'],
    ['make it night', 'time'],
    ['back up now', 'backup'],
    ['add a script', 'install'],
    ['install https://github.com/someone/some_script', 'install'],
    ['restart a script', 'ensure'],
    ['ensure qb-garages', 'ensure'],
    ['clear the streets', 'clearcars'],
    ['restart', 'restart'],
    ['stop the server', 'stop'],
    ['open files', 'open-files'],
    ['server.cfg', 'open-files'],
    ['whats wrong', 'open-health'],
    ['console', 'open-console'],
    ['settings', 'open-settings'],
    ['how do i add a car', 'open-learn'],
    ['show me around', 'tour'],
  ];
  for (const [text, id] of cases) assert.equal(top(text)?.action.id, id, `"${text}" should be ${id}, got ${top(text)?.action.id}`);
});

test('what is left after the words that matched', () => {
  assert.equal(top('kick tommy for spamming').rest, 'tommy for spamming');
  assert.equal(top('announce Car meet at 8').rest, 'car meet at 8');
  assert.equal(top('give car adder').rest, 'adder');
  assert.equal(top('tell everyone hi').rest, 'hi');
});

test('half-typed commands still find their action', () => {
  assert.equal(top('anno')?.action.id, 'announce');
  assert.equal(top('rest')?.action.id, 'restart');
  assert.equal(top('wea')?.action.id, 'weather');
  assert.equal(matchActions(VOCABULARY, 'zzzz').length, 0, 'nonsense matches nothing');
  assert.ok(matchActions(VOCABULARY, 'open').length >= 6, '"open" lists the pages');
});

test('finding the player someone means', () => {
  assert.equal(findPlayer('tommy for spamming', PLAYERS).player?.id, 3);
  assert.equal(findPlayer('tommy for spamming', PLAYERS).rest, 'for spamming');
  assert.equal(findPlayer('briggs', PLAYERS).player?.id, 3);
  assert.equal(findPlayer('12 hello', PLAYERS).player?.id, 12, 'by ID');
  assert.equal(findPlayer('id 7', PLAYERS).player?.id, 7);
  assert.equal(findPlayer('lenao', PLAYERS).player?.id, 7, 'by FiveM name too');
  assert.equal(findPlayer('tom', PLAYERS).player?.id, 15, 'a whole first name beats the start of a longer one');
  assert.equal(findPlayer('to', PLAYERS).player, null, 'two players fit just as well: not a clear match');
  assert.equal(findPlayer('nobody here', PLAYERS).player, null);
  assert.equal(findPlayer('anyone', []).player, null);
});

test('items, cars, numbers and reasons', () => {
  const items = [{ name: 'bandage', label: 'Bandage' }, { name: 'water_bottle', label: 'Bottle of Water' }, { name: 'phone', label: 'Phone' }, { name: 'radio', label: 'Radio' }];
  assert.equal(findNamed('bandage 5', items)?.name, 'bandage');
  assert.equal(findNamed('water', items)?.name, 'water_bottle');
  assert.equal(findNamed('bottle of water', items)?.name, 'water_bottle');
  assert.equal(findNamed('ph', items)?.name, 'phone');
  assert.equal(findNamed('laptop', items), null);
  assert.equal(firstNumber('bandage 5'), 5);
  assert.equal(firstNumber('bandage'), null);
  assert.equal(reasonFrom('for spamming in chat'), 'spamming in chat');
  assert.equal(keepCase('announce  Car meet at Legion Square', 'car meet at legion square'), 'Car meet at Legion Square');
  assert.equal(keepCase('kick Tommy For Spamming', 'for spamming'), 'For Spamming');
  assert.equal(keepCase('anything', 'not the end'), 'not the end', 'falls back to what it was given');
  assert.equal(normalize('  Hello   "World" '), 'hello world');
});

test('weather, time, minutes and ban lengths in plain words', () => {
  assert.equal(weatherFrom('make it rain'), 'RAIN');
  assert.equal(weatherFrom('stormy'), 'THUNDER');
  assert.equal(weatherFrom('snow'), 'SNOWLIGHT');
  assert.equal(weatherFrom('sunny please'), 'EXTRASUNNY');
  assert.equal(weatherFrom('cloudy'), 'CLOUDS');
  assert.equal(weatherFrom('nothing'), null);
  assert.deepEqual(timeFrom('make it night'), { hour: 22, minute: 0 });
  assert.deepEqual(timeFrom('noon'), { hour: 12, minute: 0 });
  assert.deepEqual(timeFrom('2pm'), { hour: 14, minute: 0 });
  assert.deepEqual(timeFrom('14:30'), { hour: 14, minute: 30 });
  assert.equal(timeFrom('whenever'), null);
  assert.equal(minutesFrom('in 15 minutes'), 15);
  assert.equal(minutesFrom('now'), null);
  assert.equal(banHoursFrom('1 day'), 24);
  assert.equal(banHoursFrom('12h'), 12);
  assert.equal(banHoursFrom('a week'), 168);
  assert.equal(banHoursFrom('forever'), null);
  assert.equal(githubUrlFrom('install https://github.com/someone/some_script please'), 'https://github.com/someone/some_script');
});
