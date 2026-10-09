// Original MIT-licensed dsh-v0.2.1-alpha.1 browser network watcher.
		function watchBrowserNetwork(controller) {
			const browser = globalThis.window;
			const initiallyAvailable = browser?.navigator?.onLine;
			if (browser === void 0 || initiallyAvailable === void 0) return () => {};
			const online = () => {
				controller.setNetworkAvailable(true);
			};
			const offline = () => {
				controller.setNetworkAvailable(false);
			};
			controller.setNetworkAvailable(initiallyAvailable);
			browser.addEventListener("online", online);
			browser.addEventListener("offline", offline);
			return () => {
				browser.removeEventListener("online", online);
				browser.removeEventListener("offline", offline);
			};
		}
