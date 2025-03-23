let rating = localStorage.getItem("rating")
if(!rating){
  rating = 1200;
  localStorage.setItem("rating", rating)
}
document.getElementById("ratingnum").innerText = rating;

function redrawMoves(){

  let doubleMove = [];
  document.getElementById("moves").innerHTML = "<br><br>";
  for(let i = 0; i < currentGame.moves.length; i++){
    doubleMove.push(currentGame.moves[i]);
    if(doubleMove.length < 2 && i != currentGame.moves.length - 1){
      continue;
    }
    console.log(doubleMove)
    let el = document.createElement("div");
    el.className = "doublemove";
    let subel1 = document.createElement("div");
    let subel2 = document.createElement("div");

    subel1.className = subel2.className = "singlemove";
    subel1.innerText = doubleMove[0];
    subel2.innerText = doubleMove[1];

    el.appendChild(subel1)
    if(doubleMove[1]){
      el.appendChild(subel2)
      doubleMove = []
    }

    document.getElementById("moves").appendChild(el);
  }

}


const archconf = {
  pieceTheme: 'img/chesspieces/wikipedia/{piece}.png',
}

let board = Chessboard('playboard')



let currentGame = null;
let currentBoard = new Chess()
let moveSelected = null;
let playedMove = null;
let whiteTurn = true;

function loadGame(game){
  currentGame = game;
  currentBoard.load_pgn(currentGame.moves.join(" "))
  const config = {
    position: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", // currentBoard.fen(),
    pieceTheme: 'img/chesspieces/wikipedia/{piece}.png',
    draggable: Boolean(currentGame),
    onDragStart: onDragStart,
    onDrop: onDrop,
    onSnapEnd: onSnapEnd
  }
  board = Chessboard('playboard', config);
  board.orientation(currentBoard.turn()=="w"?"white":"black")
  redrawMoves();

  playedMove = null;
  moveSelected = currentGame.moves.length

  updateButtonActivation();
  drawBoard()
}
loadGame({moves: []})

function playMove(move){
  playedMove = move;
  currentGame.moves.push(playedMove)
  moveSelected = currentGame.moves.length
  redrawMoves();
  updateButtonActivation();
}

function onDrop (source, target) {
  // see if the move is legal
  var move = currentBoard.move({
    from: source,
    to: target,
    promotion: 'q' 
  })


  // illegal move
  if (move === null){
    return 'snapback'
  }

  let movePGN = currentBoard.pgn().split(" ").slice(-1)[0];
  playMove(movePGN);

}
function updateButtonActivation(){
  document.querySelector(".singlemove.active")?.classList.remove("active");
  document.querySelectorAll(".singlemove")[moveSelected-1]?.classList.add("active")
}
function drawBoard(){
  let moves = currentGame.moves.slice(0, moveSelected).join(" ");
  currentBoard.load_pgn(moves)
  board.position(currentBoard.fen(), true)
}

function onDragStart (source, piece, position, orientation) {
  if(playedMove){
    return false;
  }
  if(moveSelected != currentGame.moves.length){
    return false;
  }
  if(currentGame.id == -1){
    return false;
  }
  // do not pick up pieces if the game is over
  if (currentBoard.game_over()) return false

  // only pick up pieces for the side to move
  if ((currentBoard.turn() === 'w' && piece.search(/^b/) !== -1) ||
    (currentBoard.turn() === 'b' && piece.search(/^w/) !== -1)) {
    return false
  }
}
function onSnapEnd () {
  board.position(currentBoard.fen())
}

document.body.addEventListener("keydown", e=>{
  if(e.key == "ArrowRight"){
    moveSelected++;
    updateButtonActivation();
    drawBoard();
  }
  else if(e.key == "ArrowLeft"){
    moveSelected--;
    updateButtonActivation();
    drawBoard();
  }
})
