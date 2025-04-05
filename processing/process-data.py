#!/usr/bin/env python3
import subprocess
import re
import math
import os
import chess
from tqdm import tqdm

# Configurations
STOCKFISH_PATH = "/usr/bin/stockfish"
STOCKFISH_DEPTH = 11
MAIA_BASE_CMD = "lc0 --backend=blas --weights=/home/jonathan/dev/reversePuzzles/humanModels/maia-{}.pb.gz"
MAIA_MODELS = ["1100", "1300",  "1500", "1700", "1800", "1900"]
CENTIPAWN_THRESHOLD = 200
WIN_PERCENTAGE_THRESHOLD = 40
MOVES_TO_SURVIVE = 3
NUM_MAIA_MOVES = 1
OUTPUT_FILE = "rated_reverse_puzzles.tsv"

def adjust_score_for_side(score, is_white):
    """Adjust score based on whether player is white or black"""
    if is_white:
        return score
    else:
        return -score  # Invert score for black


def start_engine(cmd):
    """Start a chess engine process"""
    process = subprocess.Popen(
        cmd, shell=True, stdin=subprocess.PIPE, stdout=subprocess.PIPE, 
        stderr=subprocess.PIPE, text=True
    )
    
    # Initialize engine
    process.stdin.write("uci\n")
    process.stdin.flush()
    
    # Wait for engine initialization
    ready = False
    while not ready:
        line = process.stdout.readline().strip()
        if "uciok" in line:
            ready = True
    
    return process

def get_stockfish_evaluation(process, fen, depth=STOCKFISH_DEPTH):
    """Get evaluation from Stockfish for a position"""
    process.stdin.write(f"position fen {fen}\n")
    process.stdin.flush()
    
    process.stdin.write(f"go depth {depth}\n")
    process.stdin.flush()
    
    # Wait for bestmove
    score = None
    best_move = None
    mate = None
    
    while not best_move:
        line = process.stdout.readline().strip()
        
        # Check for mate score
        if "score mate" in line:
            mate_match = re.search(r"score mate (-?\d+)", line)
            if mate_match:
                mate = int(mate_match.group(1))
                
        # Check for centipawn score
        elif "score cp" in line:
            score_match = re.search(r"score cp (-?\d+)", line)
            if score_match:
                score = int(score_match.group(1))
        
        # Get best move
        if line.startswith("bestmove"):
            best_move = line.split()[1]
    
    return {"score": score, "mate": mate, "bestmove": best_move}

def get_maia_top_moves(process, fen):
    """Get top moves from Maia model using MultiPV"""
    # Set MultiPV option
    process.stdin.write(f"setoption name MultiPV value {NUM_MAIA_MOVES}\n")
    process.stdin.flush()

    # Set position
    process.stdin.write(f"position fen {fen}\n")
    process.stdin.flush()

    # Start search
    process.stdin.write("go nodes 1\n")
    process.stdin.flush()

    # Collect moves from info lines
    moves = []
    done = False

    while not done:
        line = process.stdout.readline().strip()

        # Extract move from info line containing "pv" (principal variation)
        if "info" in line and " pv " in line:
            # Extract the first move of the principal variation
            match = re.search(r" pv (\S+)", line)
            if match:
                move = match.group(1)
                if move not in moves:
                    moves.append(move)

        # End of analysis
        if line.startswith("bestmove"):
            bestmove = line.split()[1]
            if bestmove not in moves and bestmove != "(none)":
                moves.append(bestmove)
            done = True

    # If we don't have enough moves, duplicate the first move
    while len(moves) < NUM_MAIA_MOVES:
        if moves:
            moves.append(moves[0])
        else:
            # Shouldn't happen, but just in case
            return ["a1a1"] * NUM_MAIA_MOVES

    return moves[:NUM_MAIA_MOVES]

def centipawns_to_win_percentage(cp):
    """Convert centipawn evaluation to win percentage"""
    return 50 + 50 * (2 / (1 + math.exp(-0.00368208 * cp)) - 1)

import math

def glicko2_rating_update(rating, rd, sigma, tau, matches, epsilon=1e-6):
    """
    Updates the rating using Glicko-2 formulas.
    
    Parameters:
      rating  - current rating (e.g. 1500)
      rd      - current rating deviation (e.g. 200)
      sigma   - current volatility (e.g. 0.06)
      tau     - system constant, governs volatility change (e.g. 0.5)
      matches - a list of tuples (opp_rating, opp_rd, score) where:
                  opp_rating: opponent's rating
                  opp_rd: opponent's rating deviation (assumed constant if not known)
                  score: 1 for win, 0 for loss
      
    Returns:
      new_rating, new_rd, new_sigma
    """
    # Step 1: Convert rating and rd to the Glicko-2 scale.
    mu = (rating - 1500) / 173.7178
    phi = rd / 173.7178

    def g(phi_j):
        return 1 / math.sqrt(1 + 3 * (phi_j**2) / (math.pi**2))
    
    def E(mu, mu_j, phi_j):
        return 1 / (1 + math.exp(-g(phi_j) * (mu - mu_j)))
    
    # If no matches played, only increase the RD (time decay)
    if not matches:
        phi_star = math.sqrt(phi**2 + sigma**2)
        return rating, phi_star * 173.7178, sigma

    # Step 2: Compute the variance v and the rating improvement estimate delta.
    v_inv = 0
    delta_sum = 0
    for opp_rating, opp_rd, score in matches:
        mu_j = (opp_rating - 1500) / 173.7178
        phi_j = opp_rd / 173.7178
        E_val = E(mu, mu_j, phi_j)
        g_phi = g(phi_j)
        v_inv += (g_phi**2) * E_val * (1 - E_val)
        delta_sum += g_phi * (score - E_val)
    v = 1 / v_inv
    delta = v * delta_sum

    # Step 3: Update the volatility sigma using an iterative algorithm.
    a = math.log(sigma**2)
    
    def f(x):
        exp_x = math.exp(x)
        return (exp_x * (delta**2 - phi**2 - v - exp_x) / (2 * (phi**2 + v + exp_x)**2)) - ((x - a) / (tau**2))
    
    A = a
    # Set initial value for B.
    if delta**2 > phi**2 + v:
        B = math.log(delta**2 - phi**2 - v)
    else:
        k = 1
        B = a - k * tau
        while f(B) < 0:
            k += 1
            B = a - k * tau

    fA = f(A)
    fB = f(B)
    
    # Iteratively find the value that makes f(x)=0.
    while abs(B - A) > epsilon:
        C = A + (A - B) * fA / (fB - fA)
        fC = f(C)
        if fC * fB < 0:
            A = B
            fA = fB
        else:
            fA /= 2
        B = C
        fB = fC
    
    sigma_prime = math.exp(A / 2)
    
    # Step 4: Update rating deviation (phi* and then phi').
    phi_star = math.sqrt(phi**2 + sigma_prime**2)
    phi_new = 1 / math.sqrt((1 / (phi_star**2)) + (1 / v))
    
    # Step 5: Update rating.
    mu_new = mu + (phi_new**2) * delta_sum
    
    # Convert ratings back to the original scale.
    new_rating = 1500 + 173.7178 * mu_new
    new_rd = 173.7178 * phi_new
    
    return new_rating, new_rd, sigma_prime

def calculate_puzzle_rating(results, current_rating=1500, current_rd=1000, current_sigma=0.1, tau=0.8):
    """
    Calculate the updated puzzle rating using Glicko-2 formulas.
    
    The 'results' parameter is a dictionary where each key represents an opponent's rating 
    (as a number or string convertible to float) and the value is a list of game outcomes
    (True for win, False for loss).
    """
    matches = []
    # Assume a default opponent RD (for example, 200).
    opponent_rd = 200
    for opp_rating in results:
        try:
            opp_rating_val = float(opp_rating)
        except ValueError:
            continue
        outcomes = results[opp_rating]
        for outcome in outcomes:
            score = 1 if outcome else 0
            matches.append((opp_rating_val, opponent_rd, score))
    
    new_rating, new_rd, new_sigma = glicko2_rating_update(current_rating, current_rd, current_sigma, tau, matches)
    return int(round(new_rating))


def main():
    # Read puzzles
    with open("puzzles.txt", "r") as f:
        positions = [line.strip() for line in f if line.strip()]
    
    # Create or open output file
    if not os.path.exists(OUTPUT_FILE):
        with open(OUTPUT_FILE, "w") as f:
            f.write("FEN\tRating\n")
    
    # Start engines once and reuse them
    stockfish = start_engine(STOCKFISH_PATH)
    maia_processes = {model: start_engine(MAIA_BASE_CMD.format(model)) for model in MAIA_MODELS}
    
    try:
        # Process each position
        for position_idx, fen in enumerate(tqdm(positions, desc="Processing puzzles")):
            try:
                # Validate FEN
                board = chess.Board(fen)
                # Determine if we're playing as white or black
                is_white = board.turn == chess.WHITE
            except ValueError:
                print(f"Invalid FEN: {fen}")
                continue
            
            # First check if position is reasonable with Stockfish
            eval_result = get_stockfish_evaluation(stockfish, fen, 11)
            
            # Skip if our position is significantly worse (accounting for side)
            if eval_result["score"] is not None:
                adjusted_score = adjust_score_for_side(eval_result["score"], is_white)
                if is_white and adjusted_score < -CENTIPAWN_THRESHOLD:
                    continue
                elif not is_white and adjusted_score > CENTIPAWN_THRESHOLD:
                    continue
            
            # Calculate initial win percentage (accounting for side)
            initial_win_pct = None
            if eval_result["mate"] is not None:
                # Handle mate scores based on perspective
                if is_white:
                    initial_win_pct = 100 if eval_result["mate"] > 0 else 0
                else:
                    initial_win_pct = 100 if eval_result["mate"] < 0 else 0
            elif eval_result["score"] is not None:
                # For centipawn scores, adjust based on side
                adjusted_score = adjust_score_for_side(eval_result["score"], is_white)
                initial_win_pct = centipawns_to_win_percentage(adjusted_score)
            
            # Results will track success/failure for each model and sequence
            results = {model: [] for model in MAIA_MODELS}
            
            # For each Maia model
            for model in MAIA_MODELS:
                # Get top moves
                top_moves = get_maia_top_moves(maia_processes[model], fen)
                
                # For each possible first move
                for move1 in top_moves:
                    # Create a fresh board for this sequence
                    board1 = chess.Board(fen)
                    
                    # Ensure move is legal
                    try:
                        move1_obj = chess.Move.from_uci(move1)
                        if move1_obj not in board1.legal_moves:
                            results[model].append(False)
                            continue
                            
                        board1.push(move1_obj)
                    except ValueError:
                        results[model].append(False)
                        continue
                    
                    # Let Stockfish respond
                    stockfish_response1 = get_stockfish_evaluation(stockfish, board1.fen())
                    
                    # Check for checkmate - we're mated if:
                    # - We're white and mate score is negative
                    # - We're black and mate score is positive
                    if stockfish_response1["mate"] is not None:
                        if (is_white and stockfish_response1["mate"] < 0) or \
                           (not is_white and stockfish_response1["mate"] > 0):
                            results[model].append(False)
                            continue
                    
                    # Apply Stockfish's move
                    try:
                        stockfish_move1 = chess.Move.from_uci(stockfish_response1["bestmove"])
                        if stockfish_move1 not in board1.legal_moves:
                            results[model].append(False)
                            continue
                            
                        board1.push(stockfish_move1)
                    except ValueError:
                        results[model].append(False)
                        continue
                    
                    # Repeat for second move
                    top_moves2 = get_maia_top_moves(maia_processes[model], board1.fen())
                    
                    for move2 in top_moves2:
                        board2 = chess.Board(board1.fen())
                        
                        try:
                            move2_obj = chess.Move.from_uci(move2)
                            if move2_obj not in board2.legal_moves:
                                results[model].append(False)
                                continue
                                
                            board2.push(move2_obj)
                        except ValueError:
                            results[model].append(False)
                            continue
                        
                        stockfish_response2 = get_stockfish_evaluation(stockfish, board2.fen())
                        
                        # Check for checkmate again
                        if stockfish_response2["mate"] is not None:
                            if (is_white and stockfish_response2["mate"] < 0) or \
                               (not is_white and stockfish_response2["mate"] > 0):
                                results[model].append(False)
                                continue
                        
                        try:
                            stockfish_move2 = chess.Move.from_uci(stockfish_response2["bestmove"])
                            if stockfish_move2 not in board2.legal_moves:
                                results[model].append(False)
                                continue
                                
                            board2.push(stockfish_move2)
                        except ValueError:
                            results[model].append(False)
                            continue
                        
                        # Repeat for third move
                        top_moves3 = get_maia_top_moves(maia_processes[model], board2.fen())
                        
                        for move3 in top_moves3:
                            board3 = chess.Board(board2.fen())
                            
                            try:
                                move3_obj = chess.Move.from_uci(move3)
                                if move3_obj not in board3.legal_moves:
                                    results[model].append(False)
                                    continue
                                    
                                board3.push(move3_obj)
                            except ValueError:
                                results[model].append(False)
                                continue
                            
                            # Final evaluation
                            final_eval = get_stockfish_evaluation(stockfish, board3.fen())
                            
                            # Calculate final win percentage (accounting for side)
                            final_win_pct = None
                            if final_eval["mate"] is not None:
                                if is_white:
                                    final_win_pct = 100 if final_eval["mate"] > 0 else 0
                                else:
                                    final_win_pct = 100 if final_eval["mate"] < 0 else 0
                            elif final_eval["score"] is not None:
                                adjusted_score = adjust_score_for_side(final_eval["score"], is_white)
                                final_win_pct = centipawns_to_win_percentage(adjusted_score)
                            
                            # Determine if this sequence is a win or loss
                            if final_win_pct is None or initial_win_pct is None:
                                results[model].append(False)
                            else:
                                # If win percentage dropped by threshold or more, it's a loss
                                win_pct_drop = initial_win_pct - final_win_pct
                                #results[model].append(win_pct_drop < WIN_PERCENTAGE_THRESHOLD)
                                # based on color
                                results[model].append(win_pct_drop < WIN_PERCENTAGE_THRESHOLD if True else win_pct_drop > WIN_PERCENTAGE_THRESHOLD)
            
            # Calculate puzzle rating
            puzzle_rating = calculate_puzzle_rating(results)
            
            # Write to output file
            with open(OUTPUT_FILE, "a") as f:
                f.write(f"{fen}\t{puzzle_rating}\n")
    
    finally:
        # Close all engine processes
        stockfish.stdin.write("quit\n")
        stockfish.stdin.flush()
        stockfish.terminate()
        
        for process in maia_processes.values():
            process.stdin.write("quit\n")
            process.stdin.flush()
            process.terminate()
main()
