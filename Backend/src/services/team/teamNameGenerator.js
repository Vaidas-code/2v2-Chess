import { ADJECTIVES, ANIMALS } from "./data.js";

function getRandomElement(array) {
	return array[Math.floor(Math.random() * array.length)];
}

export function generateTeamNames() {
	const adjective1 = getRandomElement(ADJECTIVES);
	let adjective2 = getRandomElement(ADJECTIVES);

	while (adjective2 === adjective1) {
		adjective2 = getRandomElement(ADJECTIVES);
	}

	const animal1 = getRandomElement(ANIMALS);
	let animal2 = getRandomElement(ANIMALS);

	while (animal2 === animal1) {
		animal2 = getRandomElement(ANIMALS);
	}

	const teamName1 = `${adjective1} ${animal1}`;
	const teamName2 = `${adjective2} ${animal2}`;

	return [teamName1, teamName2];
}
