'use strict';

const rp = require('request-promise'),
    config = require('./config');

class RpWrapper {
    constructor(rp) {
        this._rp = rp;
        this._REQUESTS_TIME_INTERVAL = 11000;
        this._REQUEST_MAX_COUNT = 30;
        this._requestTimes = [];
    }

    get() {
        let now = Date.now();
        if (this._requestTimes.length === this._REQUEST_MAX_COUNT) {
            let firstRequestTime = this._requestTimes[this._requestTimes.length - 1];
            let requestTimeDelta = now - firstRequestTime;
            if (requestTimeDelta < this._REQUESTS_TIME_INTERVAL) {
                let delay = this._REQUESTS_TIME_INTERVAL - requestTimeDelta;
                return new Promise((resolve, reject) => {
                    setTimeout(() => {
                        this.get.apply(this, arguments).then(resolve).catch(reject);
                    }, delay);
                });
            }
            this._requestTimes.pop();
        }
        this._requestTimes.unshift(now);
        return this._rp.get.apply(this._rp, arguments);
    }
}

class MovieInfoProvider {

    constructor() {
        this._rp = new RpWrapper(rp);
        this._genrePromise = new Promise((resolve, reject) => {
            this._rp.get({
                url: `${config.theMovieDBApiURL}genre/movie/list`,
                json: true,
                qs: { 'api_key': config.apiKey }
            }).then(body => {
                resolve(body.genres);
            });
        })
    }

    static get ontologyClass() {
        return 'MovieAndTv';
    }

    static get ontologySubclass() {
        return 'MovieAndSeries';
    }

    static get ontologyAttributes() {
        return ['cast', 'director', 'genre'];
    }

    _getPeopleId(names) {
        return new Promise((resolve, reject) => {
            let results = [];
            let promises = [];
            for (let name of names) {
                let promise = rp.get({
                    url: `${config.theMovieDBApiURL}search/person`,
                    qs: { 'api_key': config.apiKey, query: name },
                    json: true
                }).then(result => {
                    if (result.results && result.results.length > 0) {
                        results.push(result.results[0].id)
                    }
                }).catch(reject);
                promises.push(promise);
            }
            Promise.all(promises).then(() => {
                resolve(results);
            }, reject).catch(reject);
        });
    }

    _getGenreId(inputGenres) {
        return new Promise((resolve, reject) => {
            this._genrePromise.then(genres => {
                let result = [];
                for (let inputGenre of inputGenres) {
                    for (let genre of genres) {
                        if (genre.name.toLowerCase() === inputGenre.trim().toLowerCase()) {
                            result.push(genre.id);
                            break;
                        }
                    }
                }
                resolve(result);
            }).catch(reject);
        });
    }

    _formatMovieData(movies, directorIds) {
        return new Promise((resolve, reject) => {
            let formattedMoviePromises = [];
            let formattedMovies = [];
            movies.forEach((movie, index) => {
                let creditPromise = this._rp.get({
                    url: `${config.theMovieDBApiURL}movie/${movie.id}/credits`,
                    qs: { 'api_key': config.apiKey },
                    json: true
                }).catch(reject);
                let moviePromise = this._rp.get({
                    url: `${config.theMovieDBApiURL}movie/${movie.id}`,
                    qs: { 'api_key': config.apiKey },
                    json: true
                }).catch(reject);
                let formattedMoviePromise = Promise.all([creditPromise, moviePromise]).then(result => {
                    let creditResult = result[0];
                    let movieResult = result[1];
                    let directors = creditResult.crew.filter(crewMember => {
                        return crewMember.job === 'Director';
                    });

                    for (let director of directors) {
                        let faund = false;
                        for (let directorId of directorIds) {
                            if (director.id === directorId) {
                                faund = true;
                                break;
                            }
                        }
                        if (!faund) {                            
                            return;
                        }
                    }

                    directors = directors.map(director => director.name);

                    let formattedGenres = movieResult.genres.map(genre => genre.name);

                    let formattedCast = creditResult.cast.map(cast => cast.name);

                    formattedMovies.push({
                        class: MovieInfoProvider.ontologyClass,
                        subclass: MovieInfoProvider.ontologySubclass,
                        id: movieResult.id,
                        url: `http://www.imdb.com/title/${movieResult.imdb_id}`,
                        webUrl: `http://www.imdb.com/title/${movieResult.imdb_id}`,
                        source: 'themoviedb',
                        type: 'web',
                        name: movieResult.title,
                        tags: [],
                        attributes: {
                            film_and_book_genre: formattedGenres,
                            director: directors,
                            cast: formattedCast,
                            movie_or_series: 'movie'
                        }
                    });
                    if (movieResult.poster_path) {
                        movies[index].backgroundImageUrl = `http://image.tmdb.org/t/p/w780${movieResult.poster_path}`;
                    }
                }).catch(reject);

                formattedMoviePromises.push(formattedMoviePromise);
            });

            Promise.all(formattedMoviePromises).then(() => {
                resolve(formattedMovies);
            }, reject).catch(reject);
        });
    }

    execute(input, limit) {
        return new Promise((resolve, reject) => {
            input = input[0];
            let castPromise, directorPromise, genrePromise;
            if (input.cast) {
                castPromise = this._getPeopleId(input.cast);
            }
            if (input.director) {
                directorPromise = this._getPeopleId(input.director);
            }
            if (input.genre) {
                genrePromise = this._getGenreId(input.genre);
            }

            Promise.all([castPromise, directorPromise, genrePromise]).then(results => {
                let castIds = results[0];
                let directorIds = results[1];
                let genreIds = results[2];

                let qs = { 'api_key': config.apiKey };
                if (genreIds) {
                    qs.with_genres = genreIds.join('|');
                }
                if (directorIds) {
                    qs.with_crew = directorIds.join('|');
                }
                if (castIds) {
                    qs.with_cast = castIds.join('|');
                }
                rp.get({
                    url: `${config.theMovieDBApiURL}discover/movie`,
                    qs,
                    json: true
                }).then(result => {
                    this._formatMovieData(result.results, directorIds).then(results => {
                        if (limit) {
                            results = results.slice(0, limit);    
                        }                        
                        resolve(results);
                    }).catch(reject);
                }).catch(reject);
            }, reject).catch(reject);
        });
    }
}

// let movieInfo = new MovieInfoProvider();
// movieInfo.execute([{ director: ['Frank Darabont'], cast: ['Tim Robbins'], genre: ['Drama']}], 2).then(result => console.dir(result, { depth: null })).catch(console.error);
// movieInfo.execute([{ name: 'Terminator 2: Judgment Day' }]).then(console.log).catch(console.error);
// movieInfo.execute([{ director: 'James Cameron', name: 'Terminator' }, {name: 'Titanic'}]).then(console.log).catch(error => {    
//     if (error.stack) console.error(error.stack);
//     else console.error(error);
// });
//movieInfo.execute({ director: 'James Cameron' }).then(console.log);
// movieInfo.execute({ genre: 'action' }).then(console.log);

module.exports = MovieInfoProvider;