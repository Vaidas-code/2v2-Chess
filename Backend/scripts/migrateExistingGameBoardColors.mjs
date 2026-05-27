import "dotenv/config";
import pkg from "pg";

const { Client } = pkg;

function buildBoardKey(gameId, boardNumber) {
	return `${gameId}:${boardNumber}`;
}

function normalizeColor(color) {
	return typeof color === "string" ? color.trim().toLowerCase() : "";
}

async function main() {
	const client = new Client({ connectionString: process.env.DATABASE_URL });
	await client.connect();

	try {
		await client.query("BEGIN");

		const membersResult = await client.query(
			`SELECT
				t.game_id,
				tm.board_number,
				tm.team_member_id,
				tm.team_id,
				tm.piece_color
			 FROM gameplay.team_members tm
			 JOIN gameplay.teams t ON t.team_id = tm.team_id
			 ORDER BY t.game_id ASC, tm.board_number ASC, tm.team_id ASC, tm.team_member_id ASC`
		);

		const firstMovesResult = await client.query(
			`SELECT game_id, board_number, team_member_id
			 FROM (
				SELECT
					t.game_id,
					tm.board_number,
					m.team_member_id,
					ROW_NUMBER() OVER (
						PARTITION BY t.game_id, tm.board_number
						ORDER BY m.move_number ASC, m.move_id ASC
					) AS rn
				FROM gameplay.moves m
				JOIN gameplay.team_members tm ON tm.team_member_id = m.team_member_id
				JOIN gameplay.teams t ON t.team_id = tm.team_id
			 ) ranked
			 WHERE rn = 1`
		);

		const membersByBoard = new Map();

		for (let index = 0; index < membersResult.rows.length; index += 1) {
			const row = membersResult.rows[index];
			const key = buildBoardKey(row.game_id, row.board_number);
			const list = membersByBoard.get(key) ?? [];
			list.push(row);
			membersByBoard.set(key, list);
		}

		const firstMoveByBoard = new Map();

		for (let index = 0; index < firstMovesResult.rows.length; index += 1) {
			const row = firstMovesResult.rows[index];
			firstMoveByBoard.set(buildBoardKey(row.game_id, row.board_number), row.team_member_id);
		}

		const updates = [];
		let skippedBoards = 0;
		let boardsAlreadyCorrect = 0;

		for (const [boardKey, boardMembers] of membersByBoard.entries()) {
			if (boardMembers.length !== 2) {
				skippedBoards += 1;
				continue;
			}

			const uniqueTeamIds = new Set(boardMembers.map((member) => member.team_id));

			if (uniqueTeamIds.size !== 2) {
				skippedBoards += 1;
				continue;
			}

			const firstMoveTeamMemberId = firstMoveByBoard.get(boardKey);
			let whiteMember = null;
			let blackMember = null;

			if (firstMoveTeamMemberId && boardMembers.some((member) => member.team_member_id === firstMoveTeamMemberId)) {
				whiteMember = boardMembers.find((member) => member.team_member_id === firstMoveTeamMemberId) ?? null;
				blackMember = boardMembers.find((member) => member.team_member_id !== firstMoveTeamMemberId) ?? null;
			} else {
				const sortedByTeam = [...boardMembers].sort((left, right) => {
					if (left.team_id !== right.team_id) {
						return left.team_id - right.team_id;
					}

					return left.team_member_id - right.team_member_id;
				});

				const boardNumber = Number(sortedByTeam[0].board_number);
				const lowerTeamMember = sortedByTeam[0];
				const higherTeamMember = sortedByTeam[1];

				if (boardNumber % 2 === 1) {
					whiteMember = lowerTeamMember;
					blackMember = higherTeamMember;
				} else {
					whiteMember = higherTeamMember;
					blackMember = lowerTeamMember;
				}
			}

			if (!whiteMember || !blackMember) {
				skippedBoards += 1;
				continue;
			}

			const whiteCurrentColor = normalizeColor(whiteMember.piece_color);
			const blackCurrentColor = normalizeColor(blackMember.piece_color);

			if (whiteCurrentColor === "white" && blackCurrentColor === "black") {
				boardsAlreadyCorrect += 1;
				continue;
			}

			updates.push({
				gameId: whiteMember.game_id,
				boardNumber: whiteMember.board_number,
				whiteTeamMemberId: whiteMember.team_member_id,
				blackTeamMemberId: blackMember.team_member_id,
			});
		}

		let updatedBoardCount = 0;
		const affectedGames = new Set();

		for (let index = 0; index < updates.length; index += 1) {
			const update = updates[index];

			await client.query(
				`UPDATE gameplay.team_members
				 SET piece_color = CASE
					WHEN team_member_id = $1 THEN 'white'
					WHEN team_member_id = $2 THEN 'black'
					ELSE piece_color
				 END
				 WHERE team_member_id IN ($1, $2)`,
				[update.whiteTeamMemberId, update.blackTeamMemberId]
			);

			updatedBoardCount += 1;
			affectedGames.add(update.gameId);
		}

		await client.query("COMMIT");

		console.log(
			"existing_game_board_colors_migration=success",
			JSON.stringify({
				totalBoardsSeen: membersByBoard.size,
				updatedBoards: updatedBoardCount,
				alreadyCorrectBoards: boardsAlreadyCorrect,
				skippedBoards,
				affectedGames: Array.from(affectedGames).sort((a, b) => a - b),
			})
		);
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		await client.end();
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
