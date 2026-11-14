fx_version 'cerulean'
game 'gta5'
lua54 'yes'

name 'qb-control'
description 'Local API used by the CityHQ app. Only answers this PC, with a secret token.'
author 'CityHQ'
version '1.7.1'

server_script 'server.lua'
client_script 'client.lua'

-- CityHQ's announcements and messages on the player's screen.
ui_page 'html/index.html'
files { 'html/index.html' }
