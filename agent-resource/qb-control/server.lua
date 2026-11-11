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
local ROLES = { ['qbcore.god'] = true, ['qbcore.admin'] = true, ['qbcore.mod'] = true, ['group.admin'] = true }

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

local function core()
    if GetResourceState('qb-core') ~= 'started' then return nil end
    local ok, obj = pcall(function() return exports['qb-core']:GetCoreObject() end)
    return ok and obj or nil
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

local function qbPlayer(src)
    local QB = core()
    if not QB then error('qb-core is not running') end
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
            }
        end
    end
    return list
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

routes['POST /command'] = function(body)
    local command = text(body.command, 500)
    if not command or command == '' then error('Type a command first') end
    -- A resource that stops itself from inside its own code crashes the whole server.
    local lowered = command:lower()
    if lowered:find(RES:lower(), 1, true) and (lowered:find('restart', 1, true) or lowered:find('stop', 1, true) or lowered:find('ensure', 1, true)) then
        error(RES .. ' cannot be restarted from here. Restart the whole server instead.')
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
    TriggerClientEvent('QBCore:Notify', -1, message, 'primary', 10000)
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
    local items = {}
    for _, item in pairs(player.PlayerData.items or {}) do
        if type(item) == 'table' and item.name then
            items[#items + 1] = {
                name = item.name, label = item.label or item.name,
                amount = item.amount or 1, slot = item.slot,
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
    if not player.Functions.SetMoney(kind, amount, REASON) then error('QBCore refused that amount') end
    return ('%s set to %d'):format(kind, amount)
end

function playerActions.setJob(src, body)
    local QB, player = qbPlayer(src)
    local job, grade = text(body.job, 60), wholeNumber(body.grade, 0, 100) or 0
    if not job or not QB.Shared.Jobs[job] then error('Unknown job') end
    if not player.Functions.SetJob(job, grade) then error('QBCore refused that job or grade') end
    return 'Job updated'
end

function playerActions.setGang(src, body)
    local QB, player = qbPlayer(src)
    local gang, grade = text(body.gang, 60), wholeNumber(body.grade, 0, 100) or 0
    if not gang or not QB.Shared.Gangs[gang] then error('Unknown gang') end
    if not player.Functions.SetGang(gang, grade) then error('QBCore refused that gang or grade') end
    return 'Gang updated'
end

-- Servers can swap qb-inventory for tgiann-inventory, which takes the same basic item calls.
local INVENTORIES = { 'tgiann-inventory', 'qb-inventory' }
local function inventoryResource()
    for _, name in ipairs(INVENTORIES) do
        if GetResourceState(name) == 'started' then return name end
    end
end

local function changeItem(src, body, adding)
    local QB = qbPlayer(src)
    local item = text(body.item, 60)
    local amount = wholeNumber(body.amount, 1, 100000)
    if not item or not QB.Shared.Items[item] then error('Unknown item') end
    if not amount then error('Enter an amount of 1 or more') end
    local inv = inventoryResource()
    if not inv then error('No inventory script is running (tgiann-inventory or qb-inventory)') end
    local ok
    if inv == 'tgiann-inventory' then
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
    TriggerClientEvent('hospital:client:Revive', src)
    return 'Player revived'
end

function playerActions.notify(src, body)
    local message = text(body.message, 200)
    if not message or message == '' then error('Type a message first') end
    TriggerClientEvent('QBCore:Notify', src, message, 'primary', 10000)
    return 'Message sent'
end

function playerActions.heal(src)
    TriggerClientEvent(RES .. ':client:heal', src)
    if GetResourceState('qb-ambulancejob') == 'started' then
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
        TriggerClientEvent('QBCore:Command:TeleportToPlayer', src, coords)
        return ('Sent to %s'):format(GetPlayerName(tostring(target)) or 'that player')
    end
    local place = PLACES[body.place]
    if not place then error('Choose where to send them') end
    TriggerClientEvent('QBCore:Command:TeleportToCoords', src, place.x, place.y, place.z, place.h)
    return 'Sent to ' .. place.label
end

function playerActions.jail(src, body)
    qbPlayer(src)
    if GetResourceState('qb-prison') ~= 'started' then error('qb-prison is not running') end
    local months = wholeNumber(body.months, 1, 600)
    if not months then error('Choose from 1 to 600 months') end
    TriggerClientEvent('prison:client:Enter', src, months)
    return ('Sent to jail for %d months'):format(months)
end

function playerActions.unjail(src)
    qbPlayer(src)
    TriggerClientEvent('prison:client:UnjailPerson', src)
    return 'Released from jail'
end

function playerActions.spawnCar(src, body)
    local model = text(body.model, 40)
    if not model or not model:match('^[%w_]+$') then error('Choose a car') end
    TriggerClientEvent('QBCore:Command:SpawnVehicle', src, model:lower())
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
    TriggerClientEvent('QBCore:Command:DeleteVehicle', src)
    return 'Car removed'
end

routes['POST /players/action'] = function(body)
    local handler = playerActions[body.action]
    if not handler then error('Unknown player action') end
    return { message = handler(onlinePlayer(body.id), body) }
end

routes['GET /shared'] = function()
    local QB = core()
    if not QB then error('qb-core is not running') end
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
    for name, data in pairs(QB.Shared.Items or {}) do
        items[#items + 1] = { name = name, label = data.label or name }
    end
    table.sort(items, function(a, b) return a.label < b.label end)
    local moneyTypes = {}
    for name in pairs(QB.Config.Money.MoneyTypes or {}) do moneyTypes[#moneyTypes + 1] = name end
    table.sort(moneyTypes)
    local vehicles = {}
    for model, data in pairs(QB.Shared.Vehicles or {}) do
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
    return {
        jobs = grouped(QB.Shared.Jobs), gangs = grouped(QB.Shared.Gangs), items = items, moneyTypes = moneyTypes,
        vehicles = vehicles, places = places,
    }
end

-- ---------------------------------------------------------------- the world
local function weatherSync()
    if GetResourceState('qb-weathersync') ~= 'started' then error('qb-weathersync is not running') end
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
        hour = tonumber(hour), minute = tonumber(minute),
    }
end

routes['POST /world'] = function(body)
    local ws = weatherSync()
    if body.weather ~= nil then
        local weather = text(body.weather, 20)
        if not weather or not ws:setWeather(weather) then error('Unknown weather') end
    end
    if body.hour ~= nil then
        local hour, minute = wholeNumber(body.hour, 0, 23), wholeNumber(body.minute or 0, 0, 59)
        if not hour or not minute then error('Choose a time of day') end
        ws:setTime(hour, minute)
    end
    if body.blackout ~= nil then ws:setBlackout(body.blackout == true) end
    if body.timeFrozen ~= nil then ws:setTimeFreeze(body.timeFrozen == true) end
    if body.dynamicWeather ~= nil then ws:setDynamicWeather(body.dynamicWeather == true) end
    return routes['GET /world']()
end

-- ---------------------------------------------------------------- whole-server events
routes['POST /events/banner'] = function(body)
    local title = text(body.title, 80)
    local message = text(body.message, 240)
    if not message or message == '' then error('Type a message first') end
    local seconds = wholeNumber(body.seconds, 3, 900) or 10
    TriggerClientEvent(RES .. ':client:banner', -1, (title and title ~= '') and title or 'Announcement', message, seconds, body.countdown == true)
    return { sent = true, players = #GetPlayers() }
end

routes['POST /events/revive-all'] = function()
    local QB = core()
    if not QB then error('qb-core is not running') end
    local revived = 0
    for src in pairs(QB.Functions.GetQBPlayers()) do
        TriggerClientEvent('hospital:client:Revive', src)
        revived = revived + 1
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
    TriggerClientEvent(RES .. ':client:banner', -1, 'Clearing the streets', 'Empty cars will be removed in', seconds, true)
    SetTimeout(seconds * 1000, function()
        local removed = clearEmptyVehicles()
        TriggerClientEvent('QBCore:Notify', -1, ('%d empty cars were cleared from the streets'):format(removed), 'primary', 7000)
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
    if not isLoopback(req.address) then return send(res, 403, { ok = false, error = 'Forbidden' }) end
    if TOKEN == '' or req.headers['x-qbc-token'] ~= TOKEN then
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

print(('^2[qb-control]^7 ready%s'):format(TOKEN == '' and ' ^1(no token.txt, all requests will be refused)^7' or ''))
