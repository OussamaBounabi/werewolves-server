/**
 * IMPORTANT:
 * ---------
 * Do not manually edit this file if you'd like to host your server on Colyseus Cloud
 *
 * If you're self-hosting, you can see "Raw usage" from the documentation.
 *
 * See: https://docs.colyseus.io/server
 */
import { listen } from "@colyseus/tools";

// Import Colyseus config
import app from "./app.config.js";
import { resetPresence, watchNewPlayers } from "./accounts.js";

// Nobody is connected yet: nobody is online or in a room (a crash may have left some marked). 10 s at most.
await Promise.race([resetPresence(), new Promise((done) => setTimeout(done, 10_000).unref())])
  .catch((e) => console.error("resetting presence failed", e));

// Create and listen on 2567 (or PORT environment variable.)
listen(app);
watchNewPlayers(); // each new player's welcome gift
