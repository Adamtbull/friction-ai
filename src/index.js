2026-01-28T02:31:40.469Z	Initializing build environment...
2026-01-28T02:32:14.695Z	Success: Finished initializing build environment
2026-01-28T02:32:15.049Z	Cloning repository...
2026-01-28T02:31:40.469Z	Initializing build environment...
2026-01-28T02:32:14.695Z	Success: Finished initializing build environment
2026-01-28T02:32:15.049Z	Cloning repository...
2026-01-28T02:32:27.884Z	Detected the following tools from environment: 
2026-01-28T02:32:28.028Z	Executing user deploy command: npx wrangler deploy
2026-01-28T02:32:30.682Z	npm warn exec The following package was not found and will be installed: wrangler@4.61.0
2026-01-28T02:33:11.854Z	
2026-01-28T02:33:11.854Z	 ⛅️ wrangler 4.61.0
2026-01-28T02:33:11.854Z	───────────────────
2026-01-28T02:33:12.618Z	
2026-01-28T02:33:12.618Z	Cloudflare collects anonymous telemetry about your usage of Wrangler. Learn more at https://github.com/cloudflare/workers-sdk/tree/main/packages/wrangler/telemetry.md
2026-01-28T02:33:12.620Z	
2026-01-28T02:33:12.711Z	✘ [ERROR] Build failed with 1 error:
2026-01-28T02:33:12.712Z	
2026-01-28T02:33:12.712Z	  ✘ [ERROR] Expected identifier but found "“"
2026-01-28T02:33:12.712Z	  
2026-01-28T02:33:12.712Z	      src/index.js:168:0:
2026-01-28T02:33:12.712Z	        168 │ “Access-Control-Allow-Origin”: “*”,
2026-01-28T02:33:12.712Z	            ╵ ~
2026-01-28T02:33:12.713Z	  
2026-01-28T02:33:12.713Z	  
2026-01-28T02:33:12.713Z	
2026-01-28T02:33:12.713Z	
2026-01-28T02:33:12.750Z	🪵  Logs were written to "/opt/buildhome/.config/.wrangler/logs/wrangler-2026-01-28_02-33-11_160.log"
2026-01-28T02:33:12.980Z	Failed: error occurred while running deploy command