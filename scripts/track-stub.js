(() => {
  const pos = { coords: { latitude: 27.7172, longitude: 85.324, accuracy: 15 }, timestamp: Date.now() };
  Object.defineProperty(navigator, "geolocation", {
    value: {
      getCurrentPosition: (ok) => setTimeout(() => ok(pos), 10),
      watchPosition: (ok) => {
        setTimeout(() => ok(pos), 10);
        return 1;
      },
      clearWatch: () => {},
    },
    configurable: true,
  });
  // Remount the SPA onto /tracking WITHOUT a page reload, so the stub survives
  // into the component's mount effect (which is what asks for the fix).
  history.pushState({}, "", "/tracking");
  dispatchEvent(new PopStateEvent("popstate"));
  return "stubbed+remounted";
})()
