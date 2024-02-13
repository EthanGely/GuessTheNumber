import express from 'express';
import {createServer} from 'node:http';
import jwt from 'jsonwebtoken';
import session from 'express-session';
import bodyParser from 'body-parser';
import {Server} from 'socket.io';
import bcrypt from "bcrypt";
import compression from "compression";
import helmet from "helmet";

const app = express();
const server = createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(session({secret: 'secret-key', resave: true, saveUninitialized: true}));
app.use(bodyParser.urlencoded({extended: false}));
app.use(bodyParser.json());
app.use(express.static('public'));
app.use(compression());
app.use(
    helmet.contentSecurityPolicy({
        directives: {
            "script-src": ["'self'", "code.jquery.com", "cdn.jsdelivr.net"],
        },
    }),
);

const users = []; // BDD USERs

//             id = socket.id
let userTemp = {id: 0, mail: "temp", password: "$2b$10$8mvT.HRRkwLPF3aaQ9VVZ.DJ0iUUGqf1IODUL7uT0xv2j0v2uLwIa", token: ""}; // Password = "temp";
let userTemp2 = {id: 1, mail: "temp2", password: "$2b$10$xBRCmTyCNhLbKZnWZBADeeIpMCtMbvSYujxON3VQaPs2hltnk1BaG", token: ""}; // Password = "temp2";
let userTemp3 = {id: 2, mail: "temp3", password: "$2b$10$ny9GcxdQJM82LibRn/KuOeA25b3FvfV/cbtg4qhwQmihZ6VOyFobS", token: ""}; // Password = "temp3";
users.push(userTemp);
users.push(userTemp2);
users.push(userTemp3);

let lobbies = [];
// sous cette forme :
// [{id: 1, playing: false, players: {id: 1, isReady: false}]
// où players.id est l'ID dans users[];

const maxPlayers = 10;

io.on('connection', (socket) => {
    console.log("OK")

    // Met à jour l'identité d'un utilisateur / joueur si besoin (changement de page)
    socket.on("confirmId", (token, lobbyId) => {
        const user = getUserByToken(token);
        const lobby = getLobbyFromId(lobbyId);

        if (user) {
            const oldId = user.id;

            if (lobby && lobbyId) {
                let foundUser = false;
                user.id = socket.id;
                lobby.players.forEach((player) => {
                    if (player.id === oldId) {
                        player.id = socket.id;
                        foundUser = true;
                    }
                });

                if (!foundUser) {
                    addUserToLobby(user, lobby);
                }

                socket.join(`${lobby.id}`);
                io.to(`${lobby.id}`).emit("showView", "confirmation");
                updateConfirmations(`${lobby.id}`);

            } else if (user.id !== socket.id) {
                user.id = socket.id;
            }
        } else {
            io.to(socket.id).emit("changePage", "index.html");
        }
    });

    // Gestion de la connexion au login
    socket.on("login", async (login, password) => {
        const token = await checkPassword(login, password, socket.id);
        if (token) {
            io.to(socket.id).emit("loginResponse", true, "waitingRoom.html", token);
        } else {
            io.to(socket.id).emit("loginResponse", false);
        }
    })

    // Récupération des rooms (lobbies) disponibles
    socket.on("getRooms", () => {
        io.to(socket.id).emit("waitingRooms", getOpenLobbies());
    })

    // Gestion de la connexion à une room (lobby)
    socket.on("joinRoom", (token, roomId) => {
        const user = getUserByToken(token);
        const lobby = getLobbyFromId(roomId);
        if (!token || !lobby || !user) {
            io.to(socket.id).emit("changePage", "index.html");
        } else {
            addUserToLobby(user, lobby)
            io.to(socket.id).emit("changePage", "game.html", lobby.id);
            io.emit("waitingRooms", getOpenLobbies());
        }
    });

    // Gestion de la création d'une nouvelle room (lobby)
    socket.on('createRoom', (token) => {
        // Récupération de l'utilisateur actuel
        const user = getUserByToken(token);

        if (!token || !user) {
            io.to(socket.id).emit("changePage", "index.html");
        } else {
            const lobby = newLobby(user);
            // Mise à jour des lobbys
            io.emit("waitingRooms", getOpenLobbies());

            io.to(socket.id).emit("changePage", "game.html", lobby.id);
        }
    });

    socket.on('ready', (isReady) => {
        let lobby = getLobbyFromSocket(socket.id);

        if (lobby) {
            updatePlayerReady(lobby.id, socket.id, isReady);
            updateConfirmations(lobby.id);

            if (getNbPlayers(lobby.id) === getPlayersReady(lobby.id) && getPlayersReady(lobby.id) >= 2) {

                lobby.playing = true;

                const duration = Math.floor(Math.random() * (10 - 5 + 1)) + 5
                addDuration(lobby.id, duration);
                //Game is ready to start
                io.to(`${lobby.id}`).emit("updateTime", 5);
                io.to(`${lobby.id}`).emit("showTimeToFind", duration);
                io.to(`${lobby.id}`).emit("showView", "countdown");

                let secondsElapsed = 0;

                const intervalId = setInterval(() => {
                    io.to(`${lobby.id}`).emit("updateTime", 5 - secondsElapsed);

                    secondsElapsed++;

                    // 6 secondes pour afficher le 0
                    if (secondsElapsed === 6) {
                        clearInterval(intervalId);
                        startGame(lobby.id);
                    }
                }, 1000);
            }
        }

    })

    socket.on('stopTime', () => {
        stopTime(socket.id);
    })

    socket.on("disconnect", () => {
        const lobby = getLobbyFromSocket(socket.id);
        const user = getUserBySocketId(socket.id);
        if (lobby && user) {
            removeUserFromLobby(user, lobby);
            updateConfirmations(lobby.id);
        }
    })
});

function getPlayersReady(lobbyId) {
    const lobby = getLobbyFromId(lobbyId);

    if (lobby) {
        const readyPlayers = lobby.players.filter(player => player.isReady);
        return readyPlayers.length;
    } else {
        return 0; // Lobby not found
    }
}

function getNbPlayers(lobbyId) {
    const lobby = getLobbyFromId(lobbyId);

    if (lobby) {
        return lobby.players.length;
    } else {
        return 0; // Lobby not found
    }
}

function updatePlayerReady(lobbyId, socketId, isReady) {
    const lobby = getLobbyFromId(lobbyId);

    if (lobby) {
        const user = getUserBySocketId(socketId);

        if (user) {
            const player = lobby.players.find(p => p.id === user.id);

            if (player) {
                player.isReady = isReady;
            } else {
                console.log(`Player with id ${socketId} not found in lobby ${lobbyId}.`);
            }
        }
    } else {
        console.log(`Lobby with id ${lobbyId} not found.`);
    }
}

function updateConfirmations(lobbyId) {
    io.to(`${lobbyId}`).emit('updateConfirmations', `${getPlayersReady(lobbyId)}/${getNbPlayers(lobbyId)}`);
}

/**
 * Connecte un utilisateur donné à un lobby donné
 * @param playerToken
 * @param playerId
 * @param lobbyId
 * @returns {boolean}
 */
function connectUserToLobby(playerToken, playerId, lobbyId) {
    let openLobbies = getOpenLobbies();
    let lobbyIndex = openLobbies.findIndex(lobby => lobby.id === parseInt(lobbyId));

    const user = getUserByToken(playerToken);
    //If lobby is found
    if (lobbyIndex !== -1) {
        // On récupère notre lobby
        let lobby = lobbies[lobbyIndex];
        // on récupère l'index du joueur (s'il existe, -1 sinon)
        let playerIndex = lobby.players.findIndex(player => player.id === user.id);

        //Si le joueur existe
        if (playerIndex !== -1) {
            // If token exists, update playerId
            lobby.players[playerIndex].id = playerId;
        } else {
            // Sinon on l'ajoute
            lobby.players.push({id: playerId, isReady: false});
        }

        // Inutile car lobby est un pointeur, et non une copie (merci JS <3)
        lobbies[lobbyIndex] = lobby;
        return true;
    }
    return false;
}


////////////////////////////////////
////////// GAME FUNCTIONS //////////
////////////////////////////////////
/**
 * Ajoute la durée à trouver en secondes à un lobby
 * @param lobbyId
 * @param duration
 */
function addDuration(lobbyId, duration) {
    const lobby = getLobbyFromId(lobbyId);

    if (lobby) {
        lobby.duration = duration;
    }
}

/**
 * Transmet à une room que le compte à rebours a commencé.
 * Ajoute la date de début au lobby
 * @param lobbyId
 */
function startGame(lobbyId) {
    const lobby = getLobbyFromId(lobbyId);

    if (lobby) {
        io.to(`${lobbyId}`).emit("startGame");
        lobby.startTime = new Date().toISOString();
    }
}

/**
 * Arrête le chronomètre d'un joueur donné
 * @param socketId
 */
function stopTime(socketId) {
    const lobby = getLobbyFromSocket(socketId);
    const user = getUserBySocketId(socketId);

    if (lobby) {
        if (user) {

            const player = lobby.players.find(player => player.id === user.id);

            if (player) {
                player.playerTime = new Date().toISOString();

            }

            const allPlayersHaveTime = lobby.players.every(player => player.playerTime !== undefined);

            if (allPlayersHaveTime) {
                createPlayerRanking(lobby);
            }
        } else {
            console.log(`Player with id ${playerId} not found in lobby ${lobby.id}.`);
        }
    } else {
        console.log(`Player with id ${playerId} not found in any lobby.`);
    }
}

function createPlayerRanking(lobby) {

    const players = lobby.players.map(player => ({...player, startTime: new Date(lobby.startTime).getTime(), duration: lobby.duration * 1000}));

    const rankedPlayers = players.map(player => {
        const playerTime = player.playerTime ? new Date(player.playerTime).getTime() : 0;
        const expectedEndTime = player.startTime + player.duration;
        const delta = Math.round((playerTime - expectedEndTime) * 10) / 10;
        const timeSpent = Math.round(((player.duration / 1000) + (delta / 1000)) * 1000) / 1000;
        return {...player, delta, timeSpent};
    }).sort((a, b) => {
        // Compare absolute deltas first, then times
        const absoluteDeltaComparison = Math.abs(a.delta) - Math.abs(b.delta);
        return absoluteDeltaComparison !== 0 ? absoluteDeltaComparison : a.time - b.time;
    });

    rankedPlayers.forEach((player, index) => {
        player.rank = index + 1;
    });

    rankedPlayers.forEach(player => {
        io.to(player.id).emit("showResults", rankedPlayers, player.rank);
    });

}

////////////////////////////////////


////////////////////////////////////
////////// USER FUNCTIONS //////////
////////////////////////////////////
/**
 * Vérifie le couple login psw, crée sauvegarde et retourne un token
 * @param login
 * @param password
 * @param socketId
 * @returns {Promise<string|boolean>}
 */
async function checkPassword(login, password, socketId) {
    const user = users.find((u) => u.mail === login);
    const isValid = !!(user && await bcrypt.compare(password, user.password));

    if (isValid) {
        user.token = jwt.sign({mail: login, password: password}, "secret-key", {expiresIn: '1h'});
        user.id = socketId;
        return user.token;
    }
    return isValid;
}

/**
 * Recherche et retourne un utilisateur en fonction de son token
 * @param token
 * @returns {Array} User
 */
function getUserByToken(token) {
    return users.find(user => user.token === token);
}

/**
 * Recherche et retourne un utilisateur en fonction de son socketId
 * @param socketId
 * @returns {Array} User
 */
function getUserBySocketId(socketId) {
    return users.find(user => user.id === socketId);
}

////////////////////////////////////


/////////////////////////////////////
////////// LOBBY FUNCTIONS //////////
/////////////////////////////////////
/**
 * Retourne la liste des Lobbies ouverts
 * @returns {Array} Lobby
 */
function getOpenLobbies() {
    let openLobbies = [];
    lobbies.forEach((lobby) => {
        if (!lobby.playing && lobby.players.length < maxPlayers) {
            openLobbies.push(lobby);
        }
    });

    return openLobbies;
}

/**
 * Retourne le lobby correspondant à l'ID donné.
 * @param lobbyId
 * @returns {Array} Lobby
 */
function getLobbyFromId(lobbyId) {
    return lobbies.find(item => item.id === Number(lobbyId));
}

/**
 * Recherche et retourne un lobby en fonction d'un token utilisateur
 * @param token
 * @returns {Array} lobby
 */
function getLobbyFromToken(token) {
    const user = getUserByToken(token);
    if (user) {
        console.log(user)
        console.log(lobbies)
        lobbies.forEach((lobby) => {
            console.log(lobby.players);
        })
        return lobbies.find(lobby => lobby.players.some((player) => player.id === user.id));
    } else {
        console.log("getLobbyFromToken : USER NOT FOUND")
    }

}

/**
 * Recherche et retourne un lobby en fonction d'un socketId
 * @param socketId
 * @returns {Array} lobby
 */
function getLobbyFromSocket(socketId) {
    const user = getUserBySocketId(socketId);
    if (user) {
        return lobbies.find(lobby => lobby.players.some((player) => player.id === user.id));
    } else {
        console.log("getLobbyFromSocket : USER NOT FOUND")
        return null;
    }
}

function addUserToLobby(user, lobby) {
    const userExists = lobby.players.some(player => player.id === user.id);

    if (!userExists) {
        lobby.players.push({id: user.id, isReady: false});
    }
    return true;
}

function removeUserFromLobby(user, lobby) {
    const indexToRemove = lobby.players.findIndex(player => player.id === user.id);

    if (indexToRemove !== -1) {
        lobby.players.splice(indexToRemove, 1);
        return true;
    }
}

function newLobby(user) {
    const newLobby = {id: lobbies.length, playing: false, players: []};
    lobbies.push(newLobby);
    //Merci JS pour les références <3
    addUserToLobby(user, newLobby);
    return newLobby;
}

/////////////////////////////////////
try {
    server.listen(8080, '82.66.255.189', () => {
        console.log('server running at http://localhost:3000');
    });
} catch (e) {
    console.log(e);
}
