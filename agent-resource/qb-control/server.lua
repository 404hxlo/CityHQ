-- qb-control: the bridge between the running server and the CityHQ app.
-- Every request must come from this PC and carry the token in token.txt.

local RES = GetCurrentResourceName()
local PROTECTED = { [RES] = true, monitor = true }
local PERMANENT_BAN = 2147483647
local REASON = 'CityHQ'
-- A player ID from FiveM, Discord, Steam or Rockstar. Letters and digits only, so it can never
-- smuggle anything extra into a server command.
local VALID_ID = '^(license2?):(%x+)$'
local OTHER_ID = '^(fivem|discord|steam|xbl|live):(%w+)$'
-- QBCore's roles, and the groups Qbox's txAdmin recipe sets up (group.admin, group.mod, group.support).
local ROLES = {
    ['qbcore.god'] = true, ['qbcore.admin'] = true, ['qbcore.mod'] = true,
    ['group.admin'] = true, ['group.mod'] = true, ['group.support'] = true,
}

-- Where players can be sent. Taken from QBCore's own spawn and job settings.
local PLACES = {
    legion = { label = 'Legion Square', x = 195.17, y = -933.77, z = 30.2, h = 144.5 },
    police = { label = 'Mission Row Police', x = 428.23, y = -984.28, z = 30.26, h = 3.5 },
    pillbox = { label = 'Pillbox Hospital', x = 308.19, y = -595.35, z = 43.29, h = 70.0 },
    motel = { label = 'Pink Cage Motel', x = 327.56, y = -205.08, z = 54.08, h = 163.5 },
    sandy = { label = 'Sandy Shores', x = 1853.97, y = 3686.93, z = 34.27, h = 210.0 },
    paleto = { label = 'Paleto Bay', x = 80.35, y = 6424.12, z = 31.67, h = 45.5 },
    airport = { label = 'Los Santos Airport', x = -1037.74, y = -2738.04, z = 20.17, h = 330.0 },
}
local PLACE_ORDER = { 'legion', 'police', 'pillbox', 'motel', 'sandy', 'paleto', 'airport' }

local frozen = {}
AddEventHandler('playerDropped', function() frozen[source] = nil end)

local function validId(id)
    return type(id) == 'string' and #id <= 80 and (id:match(VALID_ID) ~= nil or id:match(OTHER_ID) ~= nil)
end

local function loadToken()
    local raw = LoadResourceFile(RES, 'token.txt')
    if not raw then return '' end
    return (raw:gsub('%s+', ''))
end
local TOKEN = loadToken()

-- ---------------------------------------------------------------- hosted servers
-- On a rented server CityHQ runs on someone's own PC, so the helper has to answer over the
-- internet. Only when CityHQ installed it that way (remote.txt, which only someone with the
-- server's files can add), and the token is only ever sent to the HTTPS address Cfx.re gives
-- the server, which the helper writes to address.txt for CityHQ to read through the host.
local REMOTE = LoadResourceFile(RES, 'remote.txt') ~= nil

if REMOTE then
    CreateThread(function()
        for _ = 1, 120 do
            local address = GetConvar('web_baseUrl', '')
            if address ~= '' then
                SaveResourceFile(RES, 'address.txt', address, -1)
                return
            end
            Wait(5000)
        end
    end)
end

-- Wrong tokens from outside: after 10 in a minute, outside requests are refused for 5 minutes.
local failures, failWindow, lockedUntil = 0, 0, 0
local function remoteLocked()
    return os.time() < lockedUntil
end
local function remoteFailed()
    local now = os.time()
    if now - failWindow > 60 then failures, failWindow = 0, now end
    failures = failures + 1
    if failures >= 10 then lockedUntil = now + 300 end
end

-- ---------------------------------------------------------------- the framework
-- QBCore, or Qbox (qbx_core). Qbox runs QBCore scripts through a bridge that can be turned off, so
-- on Qbox everything here uses Qbox's own exports and the scripts its txAdmin recipe installs.
local function running(name) return GetResourceState(name) == 'started' end

local function framework()
    if running('qbx_core') then return 'qbox' end
    if running('qb-core') then return 'qbcore' end
    return nil
end

local QBX = exports.qbx_core

-- The QBCore core object; on Qbox, a small table with the same few calls, made from Qbox's exports.
local function core()
    local fw = framework()
    if fw == 'qbox' then
        return {
            qbox = true,
            Functions = {
                GetPlayer = function(src) return QBX:GetPlayer(src) end,
                GetQBPlayers = function() return QBX:GetQBPlayers() or {} end,
            },
            Player = { Save = function(src) return QBX:Save(src) end },
        }
    end
    if fw ~= 'qbcore' then return nil end
    local ok, obj = pcall(function() return exports['qb-core']:GetCoreObject() end)
    return ok and obj or nil
end

-- A small message on the right of a player's screen (-1 for everyone), drawn by html/index.html.
local function notifyPlayer(target, message, ms, tag, icon)
    TriggerClientEvent(RES .. ':client:toast', target, {
        text = message, tag = tag or 'Server', icon = icon or 'message', seconds = (ms or 6000) / 1000,
    })
end

-- Scripts that differ between servers, and whether this one has them.
local function reviveScript()
    if running('qbx_medical') then return 'qbx_medical' end
    if running('qb-ambulancejob') then return 'qb-ambulancejob' end
    -- Older QBCore servers without qb-ambulancejob still listened for the same event.
    if framework() == 'qbcore' then return 'qbcore' end
end

local function jailScript()
    if running('xt-prison') then return 'xt-prison' end
    if running('qb-prison') then return 'qb-prison' end
end

-- Renewed-Weathersync also answers to the name qb-weathersync, so it's checked first.
local function weatherScript()
    if running('Renewed-Weathersync') then return 'Renewed-Weathersync' end
    if running('qb-weathersync') then return 'qb-weathersync' end
end

local function revive(src)
    local script = reviveScript()
    if script == 'qbx_medical' then return exports.qbx_medical:Revive(src) end
    if not script then error('No revive script is running (qb-ambulancejob or qbx_medical)') end
    TriggerClientEvent('hospital:client:Revive', src)
end

local function safeResourceName(name)
    return type(name) == 'string' and name:match('^[%w%-_%.]+$') ~= nil
end

local function text(value, maxLen)
    if type(value) ~= 'string' then return nil end
    value = value:gsub('[%c]', ' ')
    return value:sub(1, maxLen or 200)
end

local function wholeNumber(value, min, max)
    value = tonumber(value)
    if not value or value ~= value then return nil end
    value = math.floor(value)
    if min and value < min then return nil end
    if max and value > max then return nil end
    return value
end

local function onlinePlayer(id)
    local src = wholeNumber(id, 1)
    if not src or not GetPlayerName(tostring(src)) then error('That player is no longer online') end
    return src
end

local function noFramework()
    error('Neither qb-core nor qbx_core is running')
end

local function qbPlayer(src)
    local QB = core()
    if not QB then noFramework() end
    local player = QB.Functions.GetPlayer(src)
    if not player then error('That player has not chosen a character yet') end
    return QB, player
end

local function describePlayer(sid, QB)
    local src = tonumber(sid)
    local entry = {
        id = src,
        name = GetPlayerName(sid),
        ping = GetPlayerPing(sid),
        license = GetPlayerIdentifierByType(sid, 'license'),
        frozen = frozen[src] == true,
    }
    if QB then
        local ok, player = pcall(QB.Functions.GetPlayer, src)
        if ok and player and player.PlayerData then
            local d = player.PlayerData
            entry.citizenid = d.citizenid
            if d.charinfo then
                entry.character = ('%s %s'):format(d.charinfo.firstname or '', d.charinfo.lastname or '')
            end
            entry.money = d.money
            entry.jailMonths = d.metadata and d.metadata.injail or 0
            if d.job then
                entry.job = {
                    name = d.job.name, label = d.job.label, onduty = d.job.onduty,
                    grade = d.job.grade and d.job.grade.level or 0,
                    gradeName = d.job.grade and d.job.grade.name or nil,
                }
            end
            if d.gang then
                entry.gang = {
                    name = d.gang.name, label = d.gang.label,
                    grade = d.gang.grade and d.gang.grade.level or 0,
                    gradeName = d.gang.grade and d.gang.grade.name or nil,
                }
            end
        end
    end
    return entry
end

local function saveAll(QB)
    if not QB then return 0 end
    local saved = 0
    for src in pairs(QB.Functions.GetQBPlayers()) do
        local ok = pcall(function() QB.Player.Save(src) end)
        if ok then saved = saved + 1 end
    end
    return saved
end

local routes = {}

routes['POST /save-players'] = function()
    return { saved = saveAll(core()) }
end

-- Compiles without running, using the same Lua the server uses, so FiveM's own syntax is understood.
routes['POST /lua-check'] = function(body)
    if type(body.source) ~= 'string' then error('Missing code') end
    local chunk, err = load(body.source, '=' .. (text(body.name, 120) or 'file'), 't', {})
    if chunk then return { ok = true } end
    local line, message = tostring(err):match(':(%d+): (.*)$')
    return { ok = false, line = tonumber(line), message = message or tostring(err) }
end

routes['GET /status'] = function()
    local started, total = 0, GetNumResources()
    for i = 0, total - 1 do
        local name = GetResourceByFindIndex(i)
        if name and GetResourceState(name) == 'started' then started = started + 1 end
    end
    return {
        agentVersion = GetResourceMetadata(RES, 'version', 0),
        uptimeSec = math.floor(GetGameTimer() / 1000),
        players = #GetPlayers(),
        maxClients = GetConvarInt('sv_maxclients', 48),
        hostname = GetConvar('sv_hostname', ''),
        projectName = GetConvar('sv_projectName', ''),
        gameBuild = GetConvar('sv_enforceGameBuild', ''),
        version = GetConvar('version', ''),
        onesync = GetConvar('onesync', 'off'),
        qbcore = core() ~= nil,
        framework = framework(),
        resourcesStarted = started,
        resourcesTotal = total,
    }
end

routes['GET /resources'] = function()
    local list = {}
    for i = 0, GetNumResources() - 1 do
        local name = GetResourceByFindIndex(i)
        if name then
            list[#list + 1] = {
                name = name,
                state = GetResourceState(name),
                version = GetResourceMetadata(name, 'version', 0),
                description = GetResourceMetadata(name, 'description', 0),
                author = GetResourceMetadata(name, 'author', 0),
                -- Where it is on disk; a hosted server's list is built from this.
                path = REMOTE and GetResourcePath(name) or nil,
            }
        end
    end
    return list
end

-- What every resource needs and stands in for, from its own manifest, as FXServer read it. A
-- hosted server's Health and Problems pages use this instead of reading 300 manifests remotely.
local function metaList(name, key)
    local out = {}
    for i = 0, GetNumResourceMetadata(name, key) - 1 do
        local v = GetResourceMetadata(name, key, i)
        if v and v ~= '' and v:sub(1, 1) ~= '/' then out[#out + 1] = (v:gsub('%s*[<>=].*$', '')) end
    end
    return out
end

routes['GET /resources/meta'] = function()
    local list = {}
    for i = 0, GetNumResources() - 1 do
        local name = GetResourceByFindIndex(i)
        if name and name ~= '_cfx_internal' then
            list[#list + 1] = {
                name = name,
                state = GetResourceState(name),
                path = GetResourcePath(name),
                version = GetResourceMetadata(name, 'version', 0),
                description = GetResourceMetadata(name, 'description', 0),
                author = GetResourceMetadata(name, 'author', 0),
                dependencies = metaList(name, 'dependency'),
                provides = metaList(name, 'provide'),
            }
        end
    end
    return list
end

-- Whether the server's own database answers (a hosted one often doesn't answer CityHQ directly).
routes['GET /db-ping'] = function()
    if GetResourceState('oxmysql') ~= 'started' then error('oxmysql is not running') end
    local ok = exports.oxmysql:scalar_async('SELECT 1', {})
    return { ok = ok == 1 }
end

routes['POST /resources/action'] = function(body)
    local name, action = body.name, body.action
    if not safeResourceName(name) then error('Invalid resource name') end
    if action ~= 'start' and action ~= 'stop' and action ~= 'restart' and action ~= 'ensure' then
        error('Invalid action')
    end
    if PROTECTED[name] then error(name .. ' is needed by the server and cannot be changed') end
    ExecuteCommand(('%s %s'):format(action, name))
    Wait(600)
    return { name = name, state = GetResourceState(name) }
end

routes['POST /refresh'] = function()
    ExecuteCommand('refresh')
    Wait(800)
    return { refreshed = true }
end

-- A resource that stops or restarts itself from inside its own code crashes the whole server, and
-- commands sent here run inside this resource. So nothing may start, stop or restart it, or the
-- [folder] it's in, and exec is refused too: a .cfg file such as server.cfg starts it again.
local OWN_FOLDERS = {}
for folder in ((GetResourcePath(RES) or ''):gsub('\\', '/')):gmatch('%[[^/%]]+%]') do
    OWN_FOLDERS[#OWN_FOLDERS + 1] = folder:lower()
end
local RESTART_WORDS = { 'restart', 'stop', 'ensure', 'start' }

-- True when word appears in text on its own, not as part of a longer name.
local function hasWord(textValue, word)
    local from = 1
    while true do
        local s, e = textValue:find(word, from, true)
        if not s then return false end
        local before, after = textValue:sub(s - 1, s - 1), textValue:sub(e + 1, e + 1)
        if not before:match('[%w_%.%-]') and not after:match('[%w_%.%-]') then return true end
        from = s + 1
    end
end

local function restartsSelf(command)
    local lowered = command:lower()
    if hasWord(lowered, 'exec') then return true end
    local restarting = false
    for _, word in ipairs(RESTART_WORDS) do
        if hasWord(lowered, word) then restarting = true break end
    end
    if not restarting then return false end
    if hasWord(lowered, RES:lower()) then return true end
    for _, folder in ipairs(OWN_FOLDERS) do
        if hasWord(lowered, folder) then return true end
    end
    return false
end

routes['POST /command'] = function(body)
    local command = text(body.command, 500)
    if not command or command == '' then error('Type a command first') end
    if restartsSelf(command) then
        error(RES .. ' would stop or restart itself, which crashes the whole server. Restart the whole server instead.')
    end
    ExecuteCommand(command)
    return { ran = command }
end

routes['POST /announce'] = function(body)
    local message = text(body.message, 300)
    if not message or message == '' then error('Type a message first') end
    TriggerClientEvent('chat:addMessage', -1, {
        color = { 255, 138, 61 }, multiline = true, args = { 'Server', message },
    })
    notifyPlayer(-1, message, 10000, 'Server', 'megaphone')
    return { sent = true, players = #GetPlayers() }
end

routes['POST /prepare-shutdown'] = function(body)
    local reason = text(body.reason, 120) or 'The server is restarting. Please reconnect in a minute.'
    local saved = saveAll(core())
    for _, sid in ipairs(GetPlayers()) do DropPlayer(sid, reason) end
    Wait(800)
    return { saved = saved }
end

routes['POST /quit'] = function()
    SetTimeout(250, function() ExecuteCommand('quit "Restart requested from CityHQ"') end)
    return { quitting = true }
end

routes['GET /players'] = function()
    local QB, list = core(), {}
    for _, sid in ipairs(GetPlayers()) do
        list[#list + 1] = describePlayer(sid, QB)
    end
    return list
end

routes['POST /players/inventory'] = function(body)
    local src = onlinePlayer(body.id)
    local _, player = qbPlayer(src)
    -- ox_inventory keeps items itself (with count instead of amount); the others in PlayerData.
    local source = running('ox_inventory') and exports.ox_inventory:GetInventoryItems(src) or player.PlayerData.items
    local items = {}
    for _, item in pairs(source or {}) do
        if type(item) == 'table' and item.name then
            items[#items + 1] = {
                name = item.name, label = item.label or item.name,
                amount = item.amount or item.count or 1, slot = item.slot,
            }
        end
    end
    table.sort(items, function(a, b) return (a.slot or 0) < (b.slot or 0) end)
    return items
end

local playerActions = {}

function playerActions.kick(src, body)
    DropPlayer(tostring(src), text(body.reason, 200) or 'Removed by an admin')
    return 'Player kicked'
end

function playerActions.ban(src, body)
    local sid = tostring(src)
    local reason = text(body.reason, 200) or 'Banned by an admin'
    local hours = wholeNumber(body.hours, 1, 87600)
    local expire = hours and (os.time() + hours * 3600) or PERMANENT_BAN
    exports.oxmysql:insert_async(
        'INSERT INTO bans (name, license, discord, ip, reason, expire, bannedby) VALUES (?, ?, ?, ?, ?, ?, ?)',
        {
            GetPlayerName(sid), GetPlayerIdentifierByType(sid, 'license'),
            GetPlayerIdentifierByType(sid, 'discord'), GetPlayerIdentifierByType(sid, 'ip'),
            reason, expire, REASON,
        }
    )
    DropPlayer(sid, 'You have been banned: ' .. reason)
    return 'Player banned'
end

function playerActions.setMoney(src, body)
    local _, player = qbPlayer(src)
    local kind = text(body.type, 40)
    local amount = wholeNumber(body.amount, 0, 2000000000)
    if not kind or player.PlayerData.money[kind] == nil then error('Unknown money type') end
    if not amount then error('Enter an amount of 0 or more') end
    local ok
    if framework() == 'qbox' then ok = QBX:SetMoney(src, kind, amount, REASON) else ok = player.Functions.SetMoney(kind, amount, REASON) end
    if not ok then error('The server refused that amount') end
    return ('%s set to %d'):format(kind, amount)
end

-- Jobs and gangs by name, each with its grades.
local function jobsAndGangs(QB)
    if QB.qbox then return QBX:GetJobs() or {}, QBX:GetGangs() or {} end
    return QB.Shared.Jobs or {}, QB.Shared.Gangs or {}
end

function playerActions.setJob(src, body)
    local QB, player = qbPlayer(src)
    local job, grade = text(body.job, 60), wholeNumber(body.grade, 0, 100) or 0
    local jobs = jobsAndGangs(QB)
    if not job or not jobs[job] then error('Unknown job') end
    local ok
    if QB.qbox then ok = QBX:SetJob(src, job, grade) else ok = player.Functions.SetJob(job, grade) end
    if not ok then error('The server refused that job or grade') end
    return 'Job updated'
end

function playerActions.setGang(src, body)
    local QB, player = qbPlayer(src)
    local gang, grade = text(body.gang, 60), wholeNumber(body.grade, 0, 100) or 0
    local _, gangs = jobsAndGangs(QB)
    if not gang or not gangs[gang] then error('Unknown gang') end
    local ok
    if QB.qbox then ok = QBX:SetGang(src, gang, grade) else ok = player.Functions.SetGang(gang, grade) end
    if not ok then error('The server refused that gang or grade') end
    return 'Gang updated'
end

-- Every item the server knows, by name. ox_inventory keeps its own list; QBCore's is in qb-core.
local function itemList(QB)
    if running('ox_inventory') then
        local ok, items = pcall(function() return exports.ox_inventory:Items() end)
        if ok and type(items) == 'table' then return items end
    end
    return (QB and not QB.qbox and QB.Shared.Items) or {}
end

-- Servers can swap qb-inventory for tgiann-inventory (the same basic item calls) or ox_inventory,
-- which Qbox always uses.
local INVENTORIES = { 'ox_inventory', 'tgiann-inventory', 'qb-inventory' }
local function inventoryResource()
    for _, name in ipairs(INVENTORIES) do
        if running(name) then return name end
    end
end

local function changeItem(src, body, adding)
    local QB = qbPlayer(src)
    local item = text(body.item, 60)
    local amount = wholeNumber(body.amount, 1, 100000)
    if not item or not itemList(QB)[item] then error('Unknown item') end
    if not amount then error('Enter an amount of 1 or more') end
    local inv = inventoryResource()
    if not inv then error('No inventory script is running (ox_inventory, tgiann-inventory or qb-inventory)') end
    local ok
    if inv == 'ox_inventory' then
        if adding then ok = exports.ox_inventory:AddItem(src, item, amount) else ok = exports.ox_inventory:RemoveItem(src, item, amount) end
    elseif inv == 'tgiann-inventory' then
        if adding then ok = exports[inv]:AddItem(src, item, amount) else ok = exports[inv]:RemoveItem(src, item, amount) end
    elseif adding then
        ok = exports[inv]:AddItem(src, item, amount, false, false, REASON)
    else
        ok = exports[inv]:RemoveItem(src, item, amount, false, REASON)
    end
    if not ok then
        error(adding and 'The inventory has no room for that' or 'The player does not have that many')
    end
    if inv == 'qb-inventory' then
        TriggerClientEvent('qb-inventory:client:ItemBox', src, QB.Shared.Items[item], adding and 'add' or 'remove', amount)
    end
end

function playerActions.giveItem(src, body)
    changeItem(src, body, true)
    return 'Item given'
end

function playerActions.removeItem(src, body)
    changeItem(src, body, false)
    return 'Item removed'
end

function playerActions.revive(src)
    qbPlayer(src)
    revive(src)
    return 'Player revived'
end

function playerActions.notify(src, body)
    local message = text(body.message, 200)
    if not message or message == '' then error('Type a message first') end
    notifyPlayer(src, message, 10000, 'Staff', 'message')
    return 'Message sent'
end

function playerActions.heal(src)
    TriggerClientEvent(RES .. ':client:heal', src)
    if running('qbx_medical') then
        exports.qbx_medical:Heal(src)
    elseif running('qb-ambulancejob') then
        TriggerClientEvent('hospital:client:HealInjuries', src, 'full')
    end
    return 'Player healed'
end

function playerActions.armor(src)
    TriggerClientEvent(RES .. ':client:armor', src)
    return 'Armor given'
end

function playerActions.freeze(src)
    frozen[src] = true
    TriggerClientEvent(RES .. ':client:freeze', src, true)
    return 'Player frozen in place'
end

function playerActions.unfreeze(src)
    frozen[src] = nil
    TriggerClientEvent(RES .. ':client:freeze', src, false)
    return 'Player can move again'
end

function playerActions.teleport(src, body)
    if body.toPlayer ~= nil then
        local target = onlinePlayer(body.toPlayer)
        if target == src then error('Choose a different player to send them to') end
        local coords = GetEntityCoords(GetPlayerPed(tostring(target)))
        if framework() == 'qbox' then
            TriggerClientEvent(RES .. ':client:teleport', src, coords.x, coords.y, coords.z)
        else
            TriggerClientEvent('QBCore:Command:TeleportToPlayer', src, coords)
        end
        return ('Sent to %s'):format(GetPlayerName(tostring(target)) or 'that player')
    end
    local place = PLACES[body.place]
    if not place then error('Choose where to send them') end
    if framework() == 'qbox' then
        TriggerClientEvent(RES .. ':client:teleport', src, place.x, place.y, place.z, place.h)
    else
        TriggerClientEvent('QBCore:Command:TeleportToCoords', src, place.x, place.y, place.z, place.h)
    end
    return 'Sent to ' .. place.label
end

function playerActions.jail(src, body)
    qbPlayer(src)
    local script = jailScript()
    if not script then error('No jail script is running (qb-prison or xt-prison)') end
    local months = wholeNumber(body.months, 1, 600)
    if not months then error('Choose from 1 to 600 months') end
    -- A jail "month" is one real minute in both scripts.
    if script == 'xt-prison' then
        local state = Player(src).state
        if state and (state.jailTime or 0) > 0 then
            exports['xt-prison']:SetJailTime(src, months)
        else
            -- xt-prison takes someone to jail from their own game, through an ox_lib callback (the
            -- same one its /jail command uses). The reply goes to an event nobody listens to.
            TriggerClientEvent('__ox_cb_xt-prison:client:enterJail', src, RES, 'cityhq', months)
        end
    else
        TriggerClientEvent('prison:client:Enter', src, months)
    end
    return ('Sent to jail for %d months'):format(months)
end

function playerActions.unjail(src)
    qbPlayer(src)
    local script = jailScript()
    if not script then error('No jail script is running (qb-prison or xt-prison)') end
    if script == 'xt-prison' then
        exports['xt-prison']:SetJailTime(src, 0)
        TriggerClientEvent('__ox_cb_xt-prison:client:exitJail', src, RES, 'cityhq', true)
    else
        TriggerClientEvent('prison:client:UnjailPerson', src)
    end
    return 'Released from jail'
end

-- On Qbox: made on the server, the player put in the driver's seat, then keys and a full tank.
local function spawnQboxCar(src, model)
    local info = QBX:GetVehiclesByName(model)
    if not info then error('Unknown car') end
    local ped = GetPlayerPed(tostring(src))
    local old = GetVehiclePedIsIn(ped, false)
    if old ~= 0 then QBX:DeleteVehicle(old) end
    local coords = GetEntityCoords(ped)
    local vehicle = CreateVehicleServerSetter(joaat(info.model or model), info.type or 'automobile', coords.x, coords.y, coords.z, GetEntityHeading(ped))
    local waited = 0
    while not DoesEntityExist(vehicle) and waited < 5000 do Wait(50); waited = waited + 50 end
    if not DoesEntityExist(vehicle) then error('The car could not be made') end
    SetPedIntoVehicle(ped, vehicle, -1)
    Entity(vehicle).state:set('fuel', 100.0, true)
    if running('qbx_vehiclekeys') then
        pcall(function() exports.qbx_vehiclekeys:GiveKeys(src, vehicle, true) end)
    end
end

function playerActions.spawnCar(src, body)
    local model = text(body.model, 40)
    if not model or not model:match('^[%w_]+$') then error('Choose a car') end
    if framework() == 'qbox' then
        spawnQboxCar(src, model:lower())
    else
        TriggerClientEvent('QBCore:Command:SpawnVehicle', src, model:lower())
    end
    return 'Car spawned with keys and a full tank'
end

function playerActions.fixCar(src)
    TriggerClientEvent(RES .. ':client:fixVehicle', src)
    return 'Car repaired'
end

function playerActions.refuel(src)
    TriggerClientEvent(RES .. ':client:refuel', src)
    return 'Tank filled'
end

function playerActions.deleteCar(src)
    if framework() == 'qbox' then
        local vehicle = GetVehiclePedIsIn(GetPlayerPed(tostring(src)), false)
        if vehicle == 0 then error('They need to be in the car') end
        QBX:DeleteVehicle(vehicle)
    else
        TriggerClientEvent('QBCore:Command:DeleteVehicle', src)
    end
    return 'Car removed'
end

routes['POST /players/action'] = function(body)
    local handler = playerActions[body.action]
    if not handler then error('Unknown player action') end
    return { message = handler(onlinePlayer(body.id), body) }
end

routes['GET /shared'] = function()
    local QB = core()
    if not QB then noFramework() end
    local function grouped(source)
        local list = {}
        for name, data in pairs(source or {}) do
            local grades = {}
            for level, grade in pairs(data.grades or {}) do
                grades[#grades + 1] = { level = tonumber(level) or 0, name = grade.name }
            end
            table.sort(grades, function(a, b) return a.level < b.level end)
            list[#list + 1] = { name = name, label = data.label or name, grades = grades }
        end
        table.sort(list, function(a, b) return a.label < b.label end)
        return list
    end
    local items = {}
    for name, data in pairs(itemList(QB)) do
        if type(data) == 'table' then items[#items + 1] = { name = name, label = data.label or name } end
    end
    table.sort(items, function(a, b) return a.label < b.label end)
    local moneyTypes = {}
    if QB.qbox then
        -- Qbox's money settings aren't readable from other scripts; a player's wallet shows the kinds.
        local kinds = { cash = true, bank = true, crypto = true }
        for _, player in pairs(QB.Functions.GetQBPlayers()) do
            for name in pairs(player.PlayerData and player.PlayerData.money or {}) do kinds[name] = true end
            break
        end
        for name in pairs(kinds) do moneyTypes[#moneyTypes + 1] = name end
    else
        for name in pairs(QB.Config.Money.MoneyTypes or {}) do moneyTypes[#moneyTypes + 1] = name end
    end
    table.sort(moneyTypes)
    local vehicles = {}
    local vehicleList = QB.qbox and (QBX:GetVehiclesByName() or {}) or QB.Shared.Vehicles or {}
    for model, data in pairs(vehicleList) do
        if type(data) == 'table' then
            vehicles[#vehicles + 1] = {
                model = data.model or model, name = data.name or model,
                brand = data.brand, category = data.category,
            }
        end
    end
    table.sort(vehicles, function(a, b) return ((a.brand or '') .. a.name) < ((b.brand or '') .. b.name) end)
    local places = {}
    for _, key in ipairs(PLACE_ORDER) do places[#places + 1] = { key = key, label = PLACES[key].label } end
    local jobs, gangs = jobsAndGangs(QB)
    return {
        jobs = grouped(jobs), gangs = grouped(gangs), items = items, moneyTypes = moneyTypes,
        vehicles = vehicles, places = places,
        framework = framework(),
        -- Tools that need a script this server may not have; the app hides the ones it can't use.
        features = {
            revive = reviveScript() ~= nil,
            jail = jailScript() ~= nil,
            weather = weatherScript() ~= nil,
            dynamicWeather = weatherScript() == 'qb-weathersync',
            items = inventoryResource() ~= nil,
        },
    }
end

-- ---------------------------------------------------------------- the world
-- Every weather type GTA has.
local GTA_WEATHER = {}
for _, name in ipairs({ 'EXTRASUNNY', 'CLEAR', 'NEUTRAL', 'SMOG', 'FOGGY', 'OVERCAST', 'CLOUDS', 'CLEARING', 'RAIN', 'THUNDER', 'SNOW', 'BLIZZARD', 'SNOWLIGHT', 'XMAS', 'HALLOWEEN', 'RAIN_HALLOWEEN', 'SNOW_HALLOWEEN' }) do
    GTA_WEATHER[name] = true
end

-- Renewed-Weathersync (Qbox's recipe) answers qb-weathersync's calls too, except dynamic weather.
local function weatherSync()
    if not weatherScript() then error('No weather script is running (qb-weathersync or Renewed-Weathersync)') end
    return exports['qb-weathersync']
end

routes['GET /world'] = function()
    local ws = weatherSync()
    local hour, minute = ws:getTime()
    return {
        weather = ws:getWeatherState(),
        blackout = ws:getBlackoutState() == true,
        timeFrozen = ws:getTimeFreezeState() == true,
        dynamicWeather = ws:getDynamicWeather() == true,
        -- Renewed-Weathersync keeps its own schedule: a weather set here lasts until its next change.
        dynamicWeatherToggle = weatherScript() == 'qb-weathersync',
        script = weatherScript(),
        hour = tonumber(hour), minute = tonumber(minute),
    }
end

routes['POST /world'] = function(body)
    local ws = weatherSync()
    if body.weather ~= nil then
        local weather = text(body.weather, 20)
        if not weather or not GTA_WEATHER[weather:upper()] then error('Unknown weather') end
        -- Renewed-Weathersync doesn't answer whether it worked; qb-weathersync does.
        local ok = ws:setWeather(weather:upper())
        if weatherScript() == 'qb-weathersync' and not ok then error('Unknown weather') end
    end
    if body.hour ~= nil then
        local hour, minute = wholeNumber(body.hour, 0, 23), wholeNumber(body.minute or 0, 0, 59)
        if not hour or not minute then error('Choose a time of day') end
        ws:setTime(hour, minute)
    end
    if body.blackout ~= nil then ws:setBlackout(body.blackout == true) end
    if body.timeFrozen ~= nil then ws:setTimeFreeze(body.timeFrozen == true) end
    if body.dynamicWeather ~= nil then
        if weatherScript() == 'qb-weathersync' then
            ws:setDynamicWeather(body.dynamicWeather == true)
        elseif body.dynamicWeather == true then
            error(weatherScript() .. ' changes the weather on its own schedule, which can\'t be turned on or off from here')
        end
    end
    return routes['GET /world']()
end

-- ---------------------------------------------------------------- whole-server events
routes['POST /events/banner'] = function(body)
    local title = text(body.title, 80)
    local message = text(body.message, 240)
    if not message or message == '' then error('Type a message first') end
    local seconds = wholeNumber(body.seconds, 3, 900) or 10
    TriggerClientEvent(RES .. ':client:banner', -1, {
        tag = (title and title ~= '') and title or 'Announcement',
        title = message, seconds = seconds, countdown = body.countdown == true, icon = 'megaphone',
    })
    return { sent = true, players = #GetPlayers() }
end

routes['POST /events/revive-all'] = function()
    local QB = core()
    if not QB then noFramework() end
    if not reviveScript() then error('No revive script is running (qb-ambulancejob or qbx_medical)') end
    local revived = 0
    for src in pairs(QB.Functions.GetQBPlayers()) do
        if pcall(revive, src) then revived = revived + 1 end
    end
    return { revived = revived }
end

local function clearEmptyVehicles()
    local removed = 0
    for _, vehicle in ipairs(GetAllVehicles()) do
        local occupied = false
        for seat = -1, 6 do
            local ped = GetPedInVehicleSeat(vehicle, seat)
            if ped and ped ~= 0 then occupied = true break end
        end
        if not occupied and DoesEntityExist(vehicle) then
            DeleteEntity(vehicle)
            removed = removed + 1
        end
    end
    return removed
end

routes['POST /events/clear-vehicles'] = function(body)
    local seconds = wholeNumber(body.seconds, 0, 600) or 0
    if seconds == 0 then return { removed = clearEmptyVehicles() } end
    TriggerClientEvent(RES .. ':client:banner', -1, {
        tag = 'Server', title = 'Clearing the streets', sub = 'Empty cars will be removed in',
        seconds = seconds, countdown = true, icon = 'car',
    })
    SetTimeout(seconds * 1000, function()
        local removed = clearEmptyVehicles()
        notifyPlayer(-1, ('%d empty cars were cleared from the streets'):format(removed), 7000, 'Server', 'car')
    end)
    return { scheduled = seconds }
end

-- ---------------------------------------------------------------- whitelist
-- Kept inside the server, so it still works after a restart even if CityHQ is closed.
local whitelist = { enabled = false, ids = {} }
do
    local raw = GetResourceKvpString('cityhq:whitelist')
    local ok, saved = pcall(json.decode, raw or '')
    if ok and type(saved) == 'table' then
        whitelist.enabled = saved.enabled == true
        whitelist.ids = type(saved.ids) == 'table' and saved.ids or {}
    end
end

routes['GET /whitelist'] = function() return whitelist end

routes['POST /whitelist'] = function(body)
    local ids = {}
    for _, id in ipairs(type(body.ids) == 'table' and body.ids or {}) do
        if validId(id) then ids[#ids + 1] = id end
    end
    whitelist = { enabled = body.enabled == true, ids = ids }
    SetResourceKvp('cityhq:whitelist', json.encode(whitelist))
    return whitelist
end

AddEventHandler('playerConnecting', function(_, _, deferrals)
    if not whitelist.enabled then return end
    local src = source
    deferrals.defer()
    Wait(0)
    local allowed = {}
    for _, id in ipairs(whitelist.ids) do allowed[id] = true end
    for _, id in ipairs(GetPlayerIdentifiers(src)) do
        if allowed[id] then return deferrals.done() end
    end
    if IsPlayerAceAllowed(src, 'command') then return deferrals.done() end
    deferrals.done('This server is invite-only right now. Ask an admin to add you to the whitelist.')
end)

-- ---------------------------------------------------------------- admins
-- server.cfg holds the lasting list; this applies a change right away without a restart.
routes['POST /admins/apply'] = function(body)
    local id, role = body.identifier, body.role
    if not validId(id) then error('That is not a valid player ID') end
    if not ROLES[role] then error('Unknown role') end
    ExecuteCommand(('%s identifier.%s %s'):format(body.remove and 'remove_principal' or 'add_principal', id, role))
    local QB = core()
    for _, sid in ipairs(GetPlayers()) do
        for _, pid in ipairs(GetPlayerIdentifiers(sid)) do
            if pid == id and QB and QB.Commands and QB.Commands.Refresh then
                pcall(QB.Commands.Refresh, tonumber(sid))
            end
        end
    end
    return { applied = true }
end

routes['GET /identifiers'] = function()
    local list = {}
    for _, sid in ipairs(GetPlayers()) do
        list[#list + 1] = { id = tonumber(sid), name = GetPlayerName(sid), identifiers = GetPlayerIdentifiers(sid) }
    end
    return list
end

-- Everyone who has played, for picking admins and whitelist entries by name. On a hosted server
-- CityHQ often can't reach the database itself. A fixed query: nothing from the request goes in.
routes['GET /known-players'] = function()
    if GetResourceState('oxmysql') ~= 'started' then error('oxmysql is not running') end
    local rows = exports.oxmysql:query_async(
        "SELECT license, name, citizenid, JSON_UNQUOTE(JSON_EXTRACT(charinfo, '$.firstname')) AS firstname, "
        .. "JSON_UNQUOTE(JSON_EXTRACT(charinfo, '$.lastname')) AS lastname, UNIX_TIMESTAMP(last_updated) AS updated "
        .. 'FROM players ORDER BY last_updated DESC LIMIT 3000', {}
    ) or {}
    local list = {}
    for i, r in ipairs(rows) do
        list[i] = { r.license, r.name, r.citizenid, r.firstname, r.lastname, r.updated }
    end
    return list
end

routes['GET /bans'] = function()
    if GetResourceState('oxmysql') ~= 'started' then error('oxmysql is not running') end
    local rows = exports.oxmysql:query_async(
        'SELECT id, name, reason, expire, bannedby FROM bans ORDER BY id DESC LIMIT 200', {}
    )
    return rows or {}
end

routes['POST /bans/remove'] = function(body)
    local id = wholeNumber(body.id, 1)
    if not id then error('Invalid ban') end
    if GetResourceState('oxmysql') ~= 'started' then error('oxmysql is not running') end
    exports.oxmysql:update_async('DELETE FROM bans WHERE id = ?', { id })
    return { removed = id }
end

local function isLoopback(address)
    if type(address) ~= 'string' then return false end
    return address:match('^127%.0%.0%.1') ~= nil or address:match('^%[?::1%]?') ~= nil
end

local function send(res, status, payload)
    res.writeHead(status, { ['Content-Type'] = 'application/json' })
    res.send(json.encode(payload))
end

local function dispatch(handler, body, res)
    CreateThread(function()
        local ok, result = pcall(handler, body)
        if ok then
            -- json.encode(nil) would produce an unusable reply
            send(res, 200, { ok = true, data = result == nil and {} or result })
        else
            local message = tostring(result):gsub('^.-:%d+: ', '')
            send(res, 400, { ok = false, error = message })
        end
    end)
end

SetHttpHandler(function(req, res)
    local outside = not isLoopback(req.address)
    if outside and (not REMOTE or remoteLocked()) then return send(res, 403, { ok = false, error = 'Forbidden' }) end
    if TOKEN == '' or req.headers['x-qbc-token'] ~= TOKEN then
        if outside then remoteFailed() end
        return send(res, 401, { ok = false, error = 'Bad token' })
    end
    local path = (req.path or '/'):gsub('%?.*$', '')
    local handler = routes[(req.method or 'GET') .. ' ' .. path]
    if not handler then return send(res, 404, { ok = false, error = 'Not found' }) end

    if req.method == 'POST' then
        req.setDataHandler(function(raw)
            local ok, body = pcall(json.decode, raw or '')
            dispatch(handler, (ok and type(body) == 'table') and body or {}, res)
        end)
    else
        dispatch(handler, {}, res)
    end
end)

print(('^2[qb-control]^7 ready%s%s'):format(
    REMOTE and ' (hosted: CityHQ connects over the internet)' or '',
    TOKEN == '' and ' ^1(no token.txt, all requests will be refused)^7' or ''
))
