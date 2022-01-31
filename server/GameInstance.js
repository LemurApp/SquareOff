var NODEJS = typeof module !== 'undefined' && module.exports;

var uuid      = require('node-uuid');
var GameState = require('./GameState.js');
var config    = require('../common/config');
var Sim       = require('./Sim');
var _         = require('lodash');
var schema    = require('../common/schema');

class Player {
    constructor(player, gi, team) {
        this.gi = gi;
        this.team = team;
        this.socket = player.socket;
        this.nick = player.nick;
        this.color = player.color;

        this.connected = true;
        this.hover_block = {x: -1, y: -1};
        this.lastActionTime = Date.now();
        this.active_block = null;

        // Clear all listeners.
        this.socket.removeAllListeners('mouse_click');
        this.socket.removeAllListeners('hover_change');
        this.socket.removeAllListeners('leave_instance');
        
        // Handle hover listener.
        this.socket.on("hover_change", (grid_x, grid_y) => this.onClick(grid_x, grid_y));
        // this.socket.on("mouse_click", (grid_x, grid_y) => this.onClick(grid_x, grid_y));
        this.socket.on("leave_instance", () => this.onLeave());
    }

    sharable = () => {
        return {nick: this.nick, color: this.color};
    }

    onHoverChange = (grid_x, grid_y) => {
        var true_y = (config.GRID.HEIGHT - 1) - grid_y;
        this.hover_block = {x: grid_x, y: true_y};
        this.lastActionTime = Date.now();
    }

    onClick = (grid_x, grid_y) => {
        this.lastActionTime = Date.now();        
        var true_y = (this.team === 'b') ? ((config.GRID.HEIGHT - 1) - grid_y) : grid_y;
        this.gi.handleClick(this, grid_x, true_y, this.team);
    }

    onLeave = () => {
        console.log("Player leaving instance: ", this.team, this.nick);
        this.connected = false;
        this.gi.state = 'almost_dead';
    }
};

class Team {
    constructor(name, gi) {
        this.name = name;
        this.color = (name === 'b') ? parseInt('FF0000', 16) : parseInt('0000FF', 16);
        this.players = [];
        this.score = 0;
        this.gi = gi;
    }

    addPlayer = (player) => {
        this.players.push(new Player(player, this.gi, this.name));
    }
    blocks = () => {
        return this.players.map(p => p.active_block).filter(p => p !== null);
    }

    hoverBlocks = () => {
        return this.players.map(p => p.hover_block);
    }


    sharable = () => {
        return {nick: (this.name == 'b') ? 'Red' : 'Blue', color: this.color };
    };

    emitAll = (key, value) => {
        this.players.forEach(p => p.socket.emit(key, value));
    }
}

function GameInstance(players) {
    var self = this;
    self.id = uuid.v1(); // Unique ID for this game instance
    self.teams = {
        a: new Team('a', self),
        b: new Team('b', self),
    }

    players.forEach((p, i) => {
        if (i < config.PLAYERS_ON_TEAM) {
            self.teams.a.addPlayer(p);
        } else {
            self.teams.b.addPlayer(p);
        }
    })

    self.state = 'active';

    self.gameState = GameState();
    
    self.teams.a.emitAll('game_start', {id: self.id, me: self.teams.a.sharable(), enemy: self.teams.b.sharable()});
    self.teams.b.emitAll('game_start', {id: self.id, me: self.teams.b.sharable(), enemy: self.teams.a.sharable()});

    // set up game simulation
    self.sim = new Sim(self.gameState);
    self.sim.onScore( self.addScore.bind(self) );
    self.sim.onDestroyBlock(function (blockObj, team_letter, player) {
        player.active_block = null;
    });
    self.sim.onBounce( function() {
        self.gameState.bounce = true;
    });
    self.sim.onBlockPlaced( function () {
        self.gameState.blockPlaced = true
    });
}

GameInstance.prototype.tick = function gameInstanceTick() {

    this.checkPlayerActivity();

    this.gameState.scores.you = this.teams.a.score;
    this.gameState.scores.enemy = this.teams.b.score;
    this.gameState.hover_block = this.teams.b.hoverBlocks();
    this.gameState.pos = 1;

    // Send game state to client a
    this.teams.a.emitAll("instance_tick", schema.tickSchema.encode(this.gameState));

    this.gameState.scores.you = this.teams.b.score;
    this.gameState.scores.enemy = this.teams.a.score;
    this.gameState.hover_block = this.teams.a.hoverBlocks();
    this.gameState.disc.pos.y *= -1;
    this.gameState.disc.vel.y *= -1;
    this.gameState.grid.reverse();
    this.gameState.pos = 2;

    // send game state to client b
    this.teams.b.emitAll("instance_tick", schema.tickSchema.encode(this.gameState));

    this.gameState.grid.reverse();
    this.gameState.disc.pos.y *= -1;
    this.gameState.disc.vel.y *= -1;

    this.gameState.bounce = false;
    this.gameState.blockPlaced = false;
    this.gameState.score = false;

    this.sim.update();
};

GameInstance.prototype.checkPlayerActivity = function () {
    var nowTime = Date.now();
    this.teams.a.players.forEach(p => {
        var p_delay = nowTime - p.lastActionTime;
        if (p_delay >= config.MAX_INACTIVE_TIME) {
            console.log("Disconnecting Player for inactivity", p.id, p_delay);
            p.socket.disconnect();
        }
    });
    this.teams.b.players.forEach(p => {
        var p_delay = nowTime - p.lastActionTime;
        if (p_delay >= config.MAX_INACTIVE_TIME) {
            console.log("Disconnecting Player for inactivity", p.id, p_delay);
            p.socket.disconnect();
        }
    });
};

GameInstance.prototype.addScore = function gameInstanceAddScore(team_letter) {
    const scoringTeam = this.teams[team_letter];
    scoringTeam.score += 1;

    this.sim.reset();
    // cheap way to reinstantiate grid
    this.gameState.grid = GameState().grid;
    this.gameState.score = true;

    this.teams.a.players.forEach(p => {
        p.active_block = null;
    })
    this.teams.b.players.forEach(p => {
        p.active_block = null;
    })

    console.log('Team ' + team_letter.toUpperCase() + ' scored! New score: ' + scoringTeam.score);

    if (scoringTeam.score >= config.WINNING_SCORE) {
        this.endMatch(scoringTeam);
    }
};

GameInstance.prototype.hasPlayer = function gameInstanceHasPlayer(player) {
    if (this.teams.a.players.find(p => p.socket.id === player.id)) {
        return true;
    }
    if (this.teams.b.players.find(p => p.socket.id === player.id)) {
        return true;
    }
    return false;
};

GameInstance.prototype.removePlayer = function gameInstanceRemovePlayer(player) {
    var winning_team;

    let found = this.teams.a.players.find(p => p.socket.id === player.id);
    if (found) {
        found.connected = false;
        winning_team = this.teams.b;
    } else {
        found = this.teams.b.players.find(p => p.socket.id === player.id);
        if (found) {
            found.connected = false;
            winning_team = this.teams.a;
        }
    }

    if (this.state === 'active' && winning_team) {
        // end the match and the player who didn't disconnect wins by default
        this.endMatch(winning_team);
    }
};

GameInstance.prototype.hasConnectedPlayers = function gameInstanceHasPlayers() {
    return this.teams.a.players.reduce((prev, p) => prev || p.connected, false) || this.teams.b.players.reduce((prev, p) => prev || p.connected, false);
}

GameInstance.prototype.endMatch = function gameInstanceEndMatch(winning_team) {
    this.state = 'match_end';

    var losing_team;

    if (winning_team.name === this.teams.a.name) {
        console.log("Team A Won");
        losing_team = this.teams.b;
    }
    else {
        console.log("Player B Won");
        losing_team = this.teams.a;
    }

    this.tick();

    winning_team.emitAll("victory", {});
    losing_team.emitAll("defeat", {});
};

GameInstance.prototype.destroy = function gameInstanceDestroy() {
    // put any tear down stuff here
    this.teams.a.players.forEach(p => p.connected = false);
    this.teams.b.players.forEach(p => p.connected = false);
    this.state = 'dead';
};

GameInstance.prototype.isValidBlock = function gameInstanceIsValidBlock(grid_x, grid_y, team_letter) {
    // check that a block doesn't already exist in that location
    if (this.gameState.grid[grid_y][grid_x]) {
        return false;
    }

    // check that the block being placed not in the other players safe zone
    if (team_letter === 'b') {
        if (grid_y > (config.GRID.HEIGHT - 1) - config.GOAL.SAFE_ZONE) {
            return false; // inside player b's safe zone
        }
    }
    else if (team_letter === 'a') {
        if (grid_y < config.GOAL.SAFE_ZONE) {
            return false; // inside player b's safe zone
        }
    }

    return true; //TODO: implement
};

GameInstance.prototype.handleClick = function gameInstanceHandleClick(player, grid_x, grid_y, team_letter) {
    if (this.isValidBlock(grid_x, grid_y, team_letter)) {

        // add the latest block
        var addedBlock = this.sim.addBlock(grid_x, grid_y, team_letter, player.socket.id);

        if (addedBlock) {
            const old_block = player.active_block;
            player.active_block = {x: grid_x, y: grid_y};
            if (old_block) {
                //     // remove oldest block
                //     var removed_block = player.blocks.shift();

                this.sim.removeBlock(old_block.x, old_block.y);
            }
        }
    }
};

if (NODEJS) module.exports = GameInstance;
