const LocationService = {
  getCurrentPosition() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error('Geolocation is not supported by your browser'));
        return;
      }
      navigator.geolocation.getCurrentPosition(
        position => resolve({
          lat: position.coords.latitude,
          lon: position.coords.longitude
        }),
        error => reject(error),
        { timeout: 12000, maximumAge: 5 * 60 * 1000 }
      );
    });
  }
};
