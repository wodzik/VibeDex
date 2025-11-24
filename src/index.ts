import './style.css'

import $ from 'jquery';
import { Subscription, interval } from 'rxjs';
import { TwistyPlayer } from 'cubing/twisty';
import { Alg } from "cubing/alg";
import { cube3x3x3 } from "cubing/puzzles";
import { KPattern } from 'cubing/kpuzzle';
import { experimentalSolve3x3x3IgnoringCenters } from 'cubing/search';
import min2phase from './lib/min2phase';

min2phase.initFull();

import * as THREE from 'three';

import {
  now,
  connectGanCube,
  // GanCubeConnection,
  // GanCubeEvent,
  // GanCubeMove,
  // MacAddressProvider,
  makeTimeFromTimestamp,
  cubeTimestampCalcSkew,
  cubeTimestampLinearFit
} from 'gan-web-bluetooth';

import { SmartCubeConnection, SmartCubeEvent } from './lib/smartcube/interfaces';
import { MoyuCubeConnection } from './lib/smartcube/MoyuCube';
import { Moyu32CubeConnection } from './lib/smartcube/Moyu32Cube';
import { cubeManager, SavedCube } from './lib/smartcube/CubeManager';

import { faceletsToPattern, patternToFacelets } from './utils';
import { expandNotation, fixOrientation, getInverseMove, getOppositeMove, releaseWakeLock, initializeDefaultAlgorithms, saveAlgorithm, deleteAlgorithm, exportAlgorithms, importAlgorithms, loadAlgorithms, loadCategories, isSymmetricOLL, algToId, setStickering, loadSubsets, bestTimeString, bestTimeNumber, averageTimeString, averageOfFiveTimeNumber, learnedStatus, createTimeGraph, createStatsGraph, countMovesETM, getLastTimes, reorderAlgorithmVariants, updateAlgorithmVariant, reorderCasesInCategory } from './functions';
import { extractYouTubeEmbedUrl } from './videoHelpers';

const SOLVED_STATE = "UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB";

var twistyPlayer = new TwistyPlayer({
  puzzle: '3x3x3',
  visualization: 'PG3D',
  alg: '',
  experimentalSetupAnchor: 'start',
  background: 'none',
  controlPanel: 'none',
  viewerLink: 'none',
  hintFacelets: 'floating',
  experimentalDragInput: 'auto',
  cameraLatitude: 0,
  cameraLongitude: 0,
  tempoScale: 5,
  experimentalStickering: 'full'
});

var twistyTracker = new TwistyPlayer({
  puzzle: '3x3x3',
  visualization: 'PG3D',
  alg: '',
  experimentalSetupAnchor: 'start',
  background: 'none',
  controlPanel: 'none',
  hintFacelets: 'none',
  experimentalDragInput: 'none',
  cameraLatitude: 0,
  cameraLongitude: 0,
  cameraLatitudeLimit: 0,
  tempoScale: 5
});

$('#cube').append(twistyPlayer);

var conn: SmartCubeConnection | null;
var lastMoves: SmartCubeEvent[] = [];
var solutionMoves: SmartCubeEvent[] = [];

var twistyScene: THREE.Scene;
var twistyVantage: any;

const HOME_ORIENTATION = new THREE.Quaternion().setFromEuler(new THREE.Euler(15 * Math.PI / 180, -20 * Math.PI / 180, 0));
var cubeQuaternion: THREE.Quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(30 * Math.PI / 180, -30 * Math.PI / 180, 0));

async function amimateCubeOrientation() {
  if (!gyroscopeEnabled) {
    return;
  }
  if (!twistyScene || !twistyVantage || forceFix) {
    var vantageList = await twistyPlayer.experimentalCurrentVantages();
    twistyVantage = [...vantageList][0];
    twistyScene = await twistyVantage.scene.scene();
    if (forceFix) forceFix = false;
  }
  twistyScene.quaternion.slerp(cubeQuaternion, 0.25);
  twistyVantage.render();
  requestAnimationFrame(amimateCubeOrientation);
}
requestAnimationFrame(amimateCubeOrientation);

var basis: THREE.Quaternion | null;

async function handleGyroEvent(event: SmartCubeEvent) {
  if (event.type == "GYRO" && event.quaternion) {
    let { x: qx, y: qy, z: qz, w: qw } = event.quaternion;
    let quat = new THREE.Quaternion(qx, qz, -qy, qw).normalize();
    if (!basis) {
      basis = quat.clone().conjugate();
    }
    cubeQuaternion.copy(quat.premultiply(basis).premultiply(HOME_ORIENTATION));
    $('#quaternion').val(`x: ${qx.toFixed(3)}, y: ${qy.toFixed(3)}, z: ${qz.toFixed(3)}, w: ${qw.toFixed(3)}`);
    if (event.velocity) {
      let { x: vx, y: vy, z: vz } = event.velocity;
      $('#velocity').val(`x: ${vx}, y: ${vy}, z: ${vz}`);
    }
  }
}

// Define the type of userAlg explicitly as an array of strings
var userAlg: string[] = [];
var originalUserAlg: string[] = [];
var scrambleToAlg: string[] = [];
var badAlg: string[] = [];
var patternStates: KPattern[] = [];
var algPatternStates: KPattern[] = [];
var currentMoveIndex = 0;
var inputMode: boolean = true;
var scrambleMode: boolean = false;

type AttackCategory = 'PLL' | 'OLL';

const ATTACK_CONFIG: Record<AttackCategory, { listContainer: string; listSelector: string; label: string; sessionId: string }> = {
  PLL: {
    listContainer: '#pll-attack-list-container',
    listSelector: '#pll-attack-list',
    label: 'PLL Attack',
    sessionId: 'pll-attack-session'
  },
  OLL: {
    listContainer: '#oll-attack-list-container',
    listSelector: '#oll-attack-list',
    label: 'OLL Attack',
    sessionId: 'oll-attack-session'
  }
};

let attackModeCategory: AttackCategory | null = null;
let attackQueue: Algorithm[] = [];
let attackIndex: number = 0;
let attackSessionCategory: AttackCategory | null = null;
let visibleAttackScreen: AttackCategory | null = null;

function hideAttackLists() {
  Object.values(ATTACK_CONFIG).forEach(cfg => $(cfg.listContainer).hide());
  visibleAttackScreen = null;
}

function deactivateAttackMode() {
  attackModeCategory = null;
  attackQueue = [];
  attackIndex = 0;
  attackSessionCategory = null;
}

function showAttackList(category: AttackCategory) {
  hideAttackLists();
  $(ATTACK_CONFIG[category].listContainer).show();
  visibleAttackScreen = category;
}

function getAttackContextCategory(): AttackCategory | null {
  return attackSessionCategory || visibleAttackScreen;
}

function resetAlg() {
  currentMoveIndex = -1; // Reset the move index
  badAlg = [];
  hideMistakes();
}

function resetTimerForModeSwitch() {
  if (timerState !== "IDLE") {
    setTimerState("IDLE");
  }
  solutionMoves = [];
  currentTimerValue = 0;
  $('#timer').text('').hide();
  deactivateAttackMode();
}

function openAttackScreen(category: AttackCategory) {
  resetTimerForModeSwitch();
  $('#top-row').show();
  $('#main-column').show();
  $('#app-top').show();
  $('#load-container').hide();
  $('#save-container').hide();
  $('#options-container').hide();
  $('#help').hide();
  $('#info').hide();
  $('#alg-stats').hide();
  $('#alg-name-display-container').hide();

  showAttackList(category);
  renderAttackList(category);

  attackQueue = buildAttackQueue(category);
  attackIndex = 0;
  attackModeCategory = attackQueue.length > 0 ? category : null;

  if (attackModeCategory && attackQueue.length > 0) {
    $('#alg-input').val(attackQueue[0].algorithm);
    $('#train-alg').trigger('click');
  } else {
    $('#alg-display').text('');
    $('#alg-display-container').hide();
    $('#timer').hide();
  }
}

$('#train-alg').on('click', () => {
  // Special handling: if we're in Attack mode and timer is running,
  // treat clicking the button as a manual STOP that resets the whole attack
  // WITHOUT saving a time for the attack session.
  if (attackModeCategory && timerState === "RUNNING") {
    // Cancel current timing without recording a result
    setTimerState("IDLE");

    // Reset Attack sequence to the beginning
    attackIndex = 0;
    attackQueue = attackModeCategory ? buildAttackQueue(attackModeCategory) : [];
    if (attackQueue.length === 0) {
      deactivateAttackMode();
    } else {
      $('#alg-input').val(attackQueue[0].algorithm);
    }
    return;
  }

  const algInput = $('#alg-input').val()?.toString().trim();
  if (algInput) {
    inputMode = false;
    userAlg = expandNotation(algInput).split(/\s+/); // Split the input string into moves
    if (attackModeCategory && attackQueue.length > 0) {
      currentAlgName = attackQueue[attackIndex]?.name || '';
    } else {
      currentAlgName = checkedAlgorithms[0]?.name || '';
    }
    $('#alg-display').text(userAlg.join(' ')); // Display the alg
    $('#alg-display-container').show();
    $('#timer').show();
    $('#alg-input').hide();
    $('#save-container').hide();
    hideMistakes();
    if (scrambleMode && !alwaysScrambleTo) {
      $('#alg-scramble').hide();
      $('#alg-help-info').hide();
      scrambleMode = false;
    }
    hasFailedAlg = false;
    patternStates = [];
    algPatternStates = [];
    fetchNextPatterns();
    setTimerState("READY");
    updateTimesDisplay();
    scrambleToAlg = [];
    if (alwaysScrambleTo) {
      $('#scramble-to').trigger('click');
    }
    $("#toggle-display").css("display", "inline-flex");
    $('#alg-name-display-container').show();
    $('#alg-stats').css("display", "flex");
  } else {
    $('#alg-input').show();
    $('#alg-stats').hide();
    $('#alg-name-display-container').hide();
    $('#alg-input').get(0)?.focus();
  }
  resetAlg();
  if ($('#alg-display').text() !== '') {
    updateAlgDisplay();
  }
  updateShowVideoButtonVisibility();
});

function fetchNextPatterns() {
  drawAlgInCube();
  if (keepInitialState) {
    keepInitialState = false;
  } else {
    initialstate = patternStates.length === 0 ? myKpattern : patternStates[patternStates.length - 1];
  }
  userAlg.forEach((move, index) => {
    move = move.replace(/[()]/g, "");
    if (index === 0) patternStates[index] = initialstate.applyMove(move);
    else patternStates[index] = algPatternStates[index - 1].applyMove(move);
    algPatternStates[index] = patternStates[index];
    patternStates[index] = fixOrientation(patternStates[index]);
    //console.log("patternStates[" + index + "]=" + JSON.stringify(patternStates[index].patternData));
  });
}

function drawAlgInCube() {
  originalUserAlg = [...userAlg];
  if (randomizeAUF && scrambleToAlg.length === 0) {
    let AUF = ["U", "U'", "U2", ""];
    let randomAUF = AUF[Math.floor(Math.random() * AUF.length)];
    if (randomAUF.length > 0) {
      // check if we can add randomAUF to the beginning of the alg, as there are some tricky cases like Na, Nb, E, OLL-21, OLL-57, etc..
      // Eg: Na + U' == U + Na but Sune + U' != U + Sune
      let kpattern = faceletsToPattern(SOLVED_STATE);

      let algWithStartU = Alg.fromString("U " + userAlg.join(' '));
      let resultWithStartU = kpattern.applyAlg(algWithStartU);

      let algWithEndU = Alg.fromString(userAlg.join(' ') + " U'");
      let resultWithEndU = kpattern.applyAlg(algWithEndU);

      let algWithStartU2 = Alg.fromString("U2 " + userAlg.join(' '));
      let resultWithStartU2 = kpattern.applyAlg(algWithStartU2);

      let algWithEndU2 = Alg.fromString(userAlg.join(' ') + " U2'");
      let resultWithEndU2 = kpattern.applyAlg(algWithEndU2);

      let category = $('#category-select').val()?.toString().toLowerCase();
      let isOLL = category?.includes("oll");
      let areNotIdentical = !resultWithStartU.isIdentical(resultWithEndU) && !resultWithStartU2.isIdentical(resultWithEndU2);

      // post AUF for pll and zbll
      if (category?.includes("pll") || category?.includes("zbll")) {
        let randomPostAUF = AUF[Math.floor(Math.random() * AUF.length)];
        if (randomPostAUF.length > 0) {
          userAlg.push(randomPostAUF);
        }
      }

      if ((areNotIdentical && !isOLL) || isOLL && !isSymmetricOLL(userAlg.join(' '))) {
        userAlg.unshift(randomAUF); // add randomAUF to the beginning of the alg
        userAlg = Alg.fromString(userAlg.join(' ')).experimentalSimplify({ cancel: true, puzzleLoader: cube3x3x3 }).toString().split(/\s+/); // simplify alg by cancelling possible U moves at the beginning
        $('#alg-display').text(userAlg.join(' '));
      }
    }
  }
  if (randomizeAUF && scrambleToAlg.length > 0) {
    userAlg = [...scrambleToAlg];
    $('#alg-display').text(userAlg.join(' '));
    scrambleToAlg = [];
  }
  twistyPlayer.alg = Alg.fromString(userAlg.join(' ')).invert().toString();
}

var showMistakesTimeout: NodeJS.Timeout;
let hasShownFlashingIndicator = false;
let hasFailedAlg = false;
let previousFixHtmlLength = 0;

function showMistakesWithDelay(fixHtml: string) {
  if (fixHtml.length > 0) {
    $('#alg-fix').html(fixHtml);
    clearTimeout(showMistakesTimeout);
    showMistakesTimeout = setTimeout(function () {
      $('#alg-fix').show();
      // Only show #alg-help-info if the current fixHtml length is greater than the previous length
      let fixHtmlLength = countMovesETM(fixHtml);
      if (fixHtmlLength > previousFixHtmlLength && fixHtmlLength > 1) {
        $('#alg-help-info').removeClass('text-green-400 dark:text-green-500').addClass('text-red-400 dark:text-red-500').show();
      } else {
        $('#alg-help-info').hide();
      }
      previousFixHtmlLength = fixHtmlLength;
      // Show the red flashing indicator if enabled and not already shown
      if (!hasShownFlashingIndicator) {
        showFlashingIndicator('red', 300);
        hasShownFlashingIndicator = true;
      }
      // if the user fails the current alg, make the case appear more often
      if (checkedAlgorithms.length > 0) {
        if (prioritizeFailedAlgs && !checkedAlgorithmsCopy.includes(checkedAlgorithms[0])) {
          checkedAlgorithmsCopy.push(checkedAlgorithms[0]);
          //console.log("+++ Pushing failed alg " + checkedAlgorithms[0].name + " to checkedAlgorithmsCopy: " + JSON.stringify(checkedAlgorithmsCopy));
        }
        // mark the failed alg in red
        if (checkedAlgorithms[0].algorithm) {
          let algId = algToId(checkedAlgorithms[0].algorithm);
          if (algId && !hasFailedAlg) {
            // defined in loadAlgorithms()
            $('#' + algId).removeClass('bg-gray-50 bg-gray-400 dark:bg-gray-600 dark:bg-gray-800');
            $('#' + algId).addClass('bg-red-400 dark:bg-red-400');
            // Increase the data-failed count
            let failedCount = parseInt($('#' + algId).data('failed')) || 0;
            //console.log("+++ failedCount for " + algId + " is " + failedCount + " at currentMoveIndex: " + currentMoveIndex);
            $('#' + algId).data('failed', failedCount + 1);
            hasFailedAlg = true;
          }
        }
      }
    }, 300);  // 0.3 second
  } else {
    hideMistakes();
  }
}

function hideMistakes() {
  // Clear the timeout if hide is called before the div is shown
  clearTimeout(showMistakesTimeout);
  $('#alg-help-info').hide();
  $('#alg-fix').hide();
  $('#alg-fix').html("");
  hasShownFlashingIndicator = false; // Reset the flag
}

function updateAlgDisplay() {
  let displayHtml = '';
  let color = '';
  let previousColor = '';
  let simplifiedBadAlg: string[] = [];
  let fixHtml = '';

  if (badAlg.length > 0) {
    for (let i = 0; i < badAlg.length; i++) {
      fixHtml += getInverseMove(badAlg[badAlg.length - 1 - i]) + " ";
    }

    // simplfy badAlg
    simplifiedBadAlg = Alg.fromString(fixHtml).experimentalSimplify({ cancel: true, puzzleLoader: cube3x3x3 }).toString().split(/\s+/);
    fixHtml = simplifiedBadAlg.join(' ').trim();
    if (fixHtml.length === 0) {
      badAlg = [];
    }
  }

  let parenthesisColor = darkModeToggle.checked ? 'white' : 'black';
  var isDoubleTurn = false;
  var isOppositeMove = false;
  var isAUF = false;
  userAlg.forEach((move, index) => {
    color = darkModeToggle.checked ? 'white' : 'black'; // Default color

    // Determine the color based on the move index
    if (index <= currentMoveIndex) {
      color = 'green'; // Correct moves
    } else if (index < 1 + currentMoveIndex + simplifiedBadAlg.length) {
      color = 'red'; // Incorrect moves
    }

    // Highlight the next move
    if (index === currentMoveIndex + 1 && color !== 'red') {
      color = 'white';
    }

    let cleanMove = move.replace(/[()']/g, "").trim();

    // don't mark initial AUF as incorrect when randomAUF is enabled
    if (index === 0 && currentMoveIndex === -1 && randomizeAUF) {
      if (simplifiedBadAlg.length === 1 && simplifiedBadAlg[0][0] === 'U' && cleanMove.length > 0 && cleanMove[0].charAt(0) === 'U') {
        color = 'blue';
        isAUF = true;
      }
    }

    // Don't mark double turns and slices as errors when they are not yet completed
    if (index === currentMoveIndex + 1 && cleanMove.length > 1) {
      const isSingleBadAlg = simplifiedBadAlg.length === 1;
      const isDoubleBadAlg = simplifiedBadAlg.length === 2;
      const isTripleBadAlg = simplifiedBadAlg.length === 3;
      // when we have a U2 on an alg that contains slices or wide moves, the U turn is not really a U, but a different move depending on the orientation of the cube
      // TODO: this is could be done better by checking the center state, but it works for now
      const isSliceOrWideMove = /[MESudlrbfxyz]/.test(userAlg.slice(0, currentMoveIndex + 1).join(' '));

      if ((isSingleBadAlg && simplifiedBadAlg[0][0] === cleanMove[0]) ||
        (isSingleBadAlg && isSliceOrWideMove) ||
        (isDoubleBadAlg && 'MES'.includes(cleanMove[0])) ||
        (isTripleBadAlg && 'MES'.includes(cleanMove[0]))) {
        color = 'blue';
        isDoubleTurn = true;
      }
    }

    // don't mark a R as incorrect if it's followed by a L move, or a U as incorrect if it's followed by a D move
    let inverseMove = getInverseMove(simplifiedBadAlg[0]);
    let currentMove = userAlg[index]?.replace(/[()']/g, "");
    if (index === currentMoveIndex + 1 && simplifiedBadAlg.length === 1) {
      //console.log("inverseMove=" + inverseMove + " == nextMove=" + nextMove + " && oppositeMove=" + oppositeMove + " == currentMove=" + currentMove);
      let oppositeMove = getOppositeMove(inverseMove?.replace(/[()'2]/g, ""));
      let nextMove = userAlg[index + 1]?.replace(/[()]/g, "");
      if ((inverseMove === nextMove || (inverseMove?.charAt(0) === nextMove?.charAt(0) && nextMove?.charAt(1) == '2')) &&
        (oppositeMove === currentMove || (oppositeMove === currentMove?.charAt(0) && currentMove?.charAt(1) == '2'))) {
        color = 'white';
        isOppositeMove = true;
      }
    }
    if (index === currentMoveIndex + 2 && isOppositeMove) color = move.endsWith('2') && inverseMove != currentMove ? 'blue' : 'green';
    if (previousColor === 'blue' || (previousColor !== 'blue' && color !== 'blue' && isDoubleTurn)) color = darkModeToggle.checked ? 'white' : 'black';

    // Build moveHtml excluding parentheses
    let circleHtml = '';
    let preCircleHtml = '';
    let postCircleHtml = '';

    for (let char of move) {
      if (char === '(') {
        preCircleHtml += `<span style="color: ${parenthesisColor};">${char}</span>`;
      } else if (char === ')') {
        postCircleHtml += `<span style="color: ${parenthesisColor};">${char}</span>`;
      } else {
        circleHtml += `<span class="move" style="color: ${color}; -webkit-text-security: ${isMoveMasked ? 'disc' : 'none'};">${char}</span>`;
      }
    }

    // Wrap non-parenthesis characters in circle class if it's the current move
    if (index === currentMoveIndex + 1) {
      displayHtml += `${preCircleHtml}<span class="circle">${circleHtml}</span>${postCircleHtml} `;
    } else {
      displayHtml += `${preCircleHtml}${circleHtml}${postCircleHtml} `;
    }
    previousColor = color;
  });

  // Update the display with the constructed HTML
  $('#alg-display').html(displayHtml);

  if (isDoubleTurn || isAUF || isOppositeMove) fixHtml = '';
  if (fixHtml.length > 0) {
    showMistakesWithDelay(fixHtml);
  } else {
    hideMistakes();
  }

  // set the index to 0 when the alg is finished, displays the circle on the first move
  if (currentMoveIndex === userAlg.length - 1) currentMoveIndex = 0;
}

let keepInitialState: boolean = false;
let previousFacelets: string = '';
let isBugged = false;

async function handleMoveEvent(event: SmartCubeEvent) {
  if (event.type === "MOVE" && event.move) {

    const move = event.move;
    twistyPlayer.experimentalAddMove(move, { cancel: false });
    twistyTracker.experimentalAddMove(move, { cancel: false });

    if (scrambleMode) {

      const cubePattern = await twistyTracker.experimentalModel.currentPattern.get();
      let scramble = getScrambleToSolution(userAlg.join(' '), cubePattern);
      const currentScramble = $('#alg-scramble').text();
      const scrambleMoves = scramble.split(' ');
      const currentScrambleMoves = currentScramble.split(' ');
      const firstCurrentScrambleMove = currentScrambleMoves[0];
      const isDoubleTurn = firstCurrentScrambleMove.charAt(1) === '2';

      if (scrambleMoves.length >= currentScrambleMoves.length && scrambleMoves.length > 2) {
        if (move === firstCurrentScrambleMove || (move.charAt(0) === firstCurrentScrambleMove.charAt(0) && isDoubleTurn)) {
          // Remove the first move from the scramble if not a double turn
          scramble = currentScrambleMoves.slice(1).join(' ');
          if (isDoubleTurn) {
            scramble = move + " " + scramble;
          }
        }
      }
      // fix for opposite moves in different order, eg: U' D2 F2 -> D2 U' F2
      if (scrambleMoves.length === currentScrambleMoves.length - 1 && scrambleMoves.length > 2 && move === firstCurrentScrambleMove) {
        scramble = currentScrambleMoves.slice(1).join(' ');
      }

      if (scrambleMoves.length > currentScrambleMoves.length) {
        $('#alg-help-info').removeClass('text-red-400 dark:text-red-500').addClass('text-green-400 dark:text-green-500').show();
      } else {
        $('#alg-help-info').hide();
      }

      $('#alg-scramble').text(scramble);

      if (scramble.length === 0) {
        $('#alg-scramble').hide();
        $('#alg-help-info').hide();
        scrambleMode = false;

        // this is the initial state for the new algorithm
        initialstate = cubePattern;
        keepInitialState = true;
        $('#train-alg').trigger('click');
      }
      return;
    }

    if (timerState === "READY") {
      setTimerState("RUNNING");
    }
    if (timerState === "STOPPED") {
      setTimerState("RUNNING");
    }
    lastMoves.push(event);
    if (timerState === "RUNNING") {
      solutionMoves.push(event);
    }
    if (lastMoves.length > 256) {
      lastMoves = lastMoves.slice(-256);
    }
    if (lastMoves.length > 10) {
      var skew = cubeTimestampCalcSkew(lastMoves as any);
      $('#skew').val(skew + '%');
    }

    //console.log("MOVE: " + event.move + " currentMoveIndex: " + currentMoveIndex + " currentValue: " + userAlg[currentMoveIndex]);
    if (patternToFacelets(myKpattern) === previousFacelets && !isBugged) {
      // we hit a bug when doing a slice we get the same myKpattern twice, so we need to retrieve a new myKpattern to fix the state
      myKpattern = await twistyTracker.experimentalModel.currentPattern.get();
      isBugged = true;
    }
    previousFacelets = patternToFacelets(myKpattern);

    if (inputMode) {
      $('#alg-input').val(function (_, currentValue) {
        return Alg.fromString(currentValue + " " + move).experimentalSimplify({ cancel: true, puzzleLoader: cube3x3x3 }).toString();
      });
      return;
    };

    // Check if the current move matches the user's alg
    var found: boolean = false;
    patternStates.forEach((pattern, index) => {
      // Use the same matching logic as in normal practice mode
      if (myKpattern.applyMove(move).isIdentical(pattern) || (isBugged && myKpattern.isIdentical(pattern))) {
        isBugged = false;
        currentMoveIndex = index;
        found = true;
        badAlg = [];
        if (currentMoveIndex === userAlg.length - 1) {
          if (attackModeCategory && attackQueue.length > 0) {
            // Completed current Attack algorithm
            const activeCategory = attackModeCategory;
            resetAlg();

            // Advance to next algorithm in Attack queue
            attackIndex++;

            if (attackIndex < attackQueue.length) {
              const next = attackQueue[attackIndex];
              $('#alg-input').val(next.algorithm);

              // Load next algorithm without restarting the timer
              inputMode = false;
              userAlg = expandNotation(next.algorithm).split(/\s+/);
              currentAlgName = next.name || '';
              $('#alg-display').text(userAlg.join(' '));
              $('#alg-display-container').show();
              hideMistakes();
              hasFailedAlg = false;
              patternStates = [];
              algPatternStates = [];
              initialstate = pattern;
              keepInitialState = true;
              fetchNextPatterns();
              if ($('#alg-display').text() !== '') {
                updateAlgDisplay();
              }
            } else {
              // Last alg in the list finished – stop timer and end Attack mode
              attackModeCategory = null;
              // Mark Attack session as active for STOPPED, then clear it
              attackSessionCategory = activeCategory;
              setTimerState("STOPPED");
              attackSessionCategory = null;
            }
            return;
          } else {
            setTimerState("STOPPED");
            resetAlg();
            fetchNextPatterns();
            currentMoveIndex = userAlg.length - 1;

            // Switch to next algorithm
            switchToNextAlgorithm();

            // this is the initial state for the new algorithm
            initialstate = pattern;
            keepInitialState = true;
            if (checkedAlgorithms.length > 0) {
              const nextAlgorithm = refreshCheckedAlgorithmAt(0);
              if (nextAlgorithm) {
                $('#alg-input').val(nextAlgorithm);
              }
            }
            $('#train-alg').trigger('click');
            return;
          }
        }
        return;
      }
    });
    if (!found) {
      badAlg.push(move);
      //console.log("Pushing 1 incorrect move. badAlg: " + badAlg)

      if (currentMoveIndex === 0 && badAlg.length === 1 && lastMoves[lastMoves.length - 1].move === getInverseMove(userAlg[currentMoveIndex].replace(/[()]/g, ""))) {
        currentMoveIndex--;
        badAlg.pop();
        //console.log("Cancelling first correct move");
      } else if (lastMoves[lastMoves.length - 1].move === getInverseMove(badAlg[badAlg.length - 2])) {
        badAlg.pop();
        badAlg.pop();
        //console.log("Popping last incorrect move. badAlg=" + badAlg);
      } else if (badAlg.length > 3 && lastMoves.length > 3 && lastMoves[lastMoves.length - 1].move === lastMoves[lastMoves.length - 2].move && lastMoves[lastMoves.length - 2].move === lastMoves[lastMoves.length - 3].move && lastMoves[lastMoves.length - 3].move === lastMoves[lastMoves.length - 4].move) {
        badAlg.pop();
        badAlg.pop();
        badAlg.pop();
        badAlg.pop();
        //console.log("Popping a turn (4 incorrect moves)");
      }
    }
    updateAlgDisplay();
  }
}

function showFlashingIndicator(color: string, duration: number) {
  // Show the flashing indicator
  const flashingIndicator = document.getElementById('flashing-indicator');
  if (flashingIndicator && flashingIndicatorEnabled) {
    flashingIndicator.style.backgroundColor = color;
    flashingIndicator.classList.remove('hidden');
    setTimeout(() => {
      flashingIndicator.classList.add('hidden');
    }, duration); // Hide after duration in milliseconds
  }
}

function switchToNextAlgorithm() {
  // Show the flashing indicator
  showFlashingIndicator('green', 200);

  // switch to next algorithm
  if (checkedAlgorithms.length + checkedAlgorithmsCopy.length > 1) {
    const currentAlg = checkedAlgorithms.shift(); // Remove the first algorithm
    if (checkedAlgorithms.length === 0) {
      checkedAlgorithms = [...checkedAlgorithmsCopy]; // Copy remaining algorithms
      checkedAlgorithmsCopy = [];
      if (prioritizeSlowAlgs) {
        checkedAlgorithms.sort((a, b) => b.bestTime - a.bestTime);
      }
    }
    // Randomize checkedAlgorithms if random is enabled
    if (randomAlgorithms) {
      checkedAlgorithms.sort(() => Math.random() - 0.5);
    }
    if (currentAlg) {
      checkedAlgorithmsCopy.push(currentAlg); // Add current algorithm to the copy
    }
  }
}

var cubeStateInitialized = false;
async function handleFaceletsEvent(event: SmartCubeEvent) {
  if (event.type == "FACELETS" && !cubeStateInitialized) {
    if (event.facelets && event.facelets != SOLVED_STATE) {
      var kpattern = faceletsToPattern(event.facelets);
      var solution = await experimentalSolve3x3x3IgnoringCenters(kpattern);
      var scramble = solution.invert();
      twistyTracker.alg = scramble;
      twistyPlayer.alg = scramble;
    } else {
      twistyTracker.alg = '';
      twistyPlayer.alg = '';
    }
    cubeStateInitialized = true;
    console.log("Initial cube state is applied successfully", event.facelets);
  }
}

function handleCubeEvent(event: SmartCubeEvent) {
  //if (event.type != "GYRO") console.log("GanCubeEvent", event);
  if (event.type == "GYRO") {
    handleGyroEvent(event);
  } else if (event.type == "MOVE") {
    handleMoveEvent(event);
  } else if (event.type == "FACELETS") {
    handleFaceletsEvent(event);
  } else if (event.type == "HARDWARE") {
    $('#hardwareName').val(event.hardwareName || '- n/a -');
    $('#hardwareVersion').val(event.hardwareVersion || '- n/a -');
    $('#softwareVersion').val(event.softwareVersion || '- n/a -');
    $('#productDate').val(event.productDate || '- n/a -');
    $('#gyroSupported').val(event.gyroSupported ? "YES" : "NO");
  } else if (event.batteryLevel !== undefined) {
    $('#batteryLevel').val(event.batteryLevel + '%');
    $('#battery-indicator').text(event.batteryLevel + '%').removeClass('hidden');
    $('#bluetooth-indicator').addClass('hidden');
    $('#battery-indicator').attr('title', event.batteryLevel + '%');
    if (event.batteryLevel && event.batteryLevel >= 75) {
      $('#battery-indicator').html('<svg fill="none" class="h-8 w-8 inline-block" viewBox="0 0 24 24" version="1.1" xmlns="http://www.w3.org/2000/svg"><path d="M18.5 7.5L3.5 7.50001V16.5L18.5 16.5V14.3571H20.5V9.21429H18.5V7.5Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M5.5 10.5C5.5 9.94772 5.94772 9.5 6.5 9.5H7.5C8.05228 9.5 8.5 9.94772 8.5 10.5V13.5C8.5 14.0523 8.05228 14.5 7.5 14.5H6.5C5.94772 14.5 5.5 14.0523 5.5 13.5V10.5Z" fill="currentColor"/><path d="M9.5 10.5C9.5 9.94772 9.94772 9.5 10.5 9.5H11.5C12.0523 9.5 12.5 9.94772 12.5 10.5V13.5C12.5 14.0523 12.0523 14.5 11.5 14.5H10.5C9.94772 14.5 9.5 14.0523 9.5 13.5V10.5Z" fill="currentColor"/><path d="M13.5 10.5C13.5 9.94772 13.9477 9.5 14.5 9.5H15.5C16.0523 9.5 16.5 9.94772 16.5 10.5V13.5C16.5 14.0523 16.0523 14.5 15.5 14.5H14.5C13.9477 14.5 13.5 14.0523 13.5 13.5V10.5Z" fill="currentColor"/></svg>');
      $('#battery-indicator').css('color', 'green');
    }
    else if (event.batteryLevel && event.batteryLevel >= 50) {
      $('#battery-indicator').html('<svg fill="none" class="h-8 w-8 inline-block" viewBox="0 0 24 24" version="1.1" xmlns="http://www.w3.org/2000/svg"><path d="M18.5 7.5L3.5 7.50001V16.5L18.5 16.5V14.3571H20.5V9.21429H18.5V7.5Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M5.5 10.5C5.5 9.94772 5.94772 9.5 6.5 9.5H7.5C8.05228 9.5 8.5 9.94772 8.5 10.5V13.5C8.5 14.0523 8.05228 14.5 7.5 14.5H6.5C5.94772 14.5 5.5 14.0523 5.5 13.5V10.5Z" fill="currentColor"/><path d="M9.5 10.5C9.5 9.94772 9.94772 9.5 10.5 9.5H11.5C12.0523 9.5 12.5 9.94772 12.5 10.5V13.5C12.5 14.0523 12.0523 14.5 11.5 14.5H10.5C9.94772 14.5 9.5 14.0523 9.5 13.5V10.5Z" fill="currentColor"/></svg>');
      $('#battery-indicator').css('color', 'yellow');
    }
    else if (event.batteryLevel && event.batteryLevel >= 20) {
      $('#battery-indicator').html('<svg fill="none" class="h-8 w-8 inline-block" viewBox="0 0 24 24" version="1.1" xmlns="http://www.w3.org/2000/svg"><path d="M18.5 7.5L3.5 7.50001V16.5L18.5 16.5V14.3571H20.5V9.21429H18.5V7.5Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M5.5 10.5C5.5 9.94772 5.94772 9.5 6.5 9.5H7.5C8.05228 9.5 8.5 9.94772 8.5 10.5V13.5C8.5 14.0523 8.05228 14.5 7.5 14.5H6.5C5.94772 14.5 5.5 14.0523 5.5 13.5V10.5Z" fill="currentColor"/></svg>');
      $('#battery-indicator').css('color', 'orange');
    }
    else if (event.batteryLevel && event.batteryLevel < 20) {
      $('#battery-indicator').html('<svg fill="none" class="h-8 w-8 inline-block" viewBox="0 0 24 24" version="1.1" xmlns="http://www.w3.org/2000/svg"><path d="M18.5 7.5L3.5 7.50001V16.5L18.5 16.5V14.3571H20.5V9.21429H18.5V7.5Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M11 10V12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M11.75 14.25C11.75 14.6642 11.4142 15 11 15C10.5858 15 10.25 14.6642 10.25 14.25C10.25 13.8358 10.5858 13.5 11 13.5C11.4142 13.5 11.75 13.8358 11.75 14.25Z" fill="currentColor"/></svg>');
      $('#battery-indicator').css('color', 'red');
    }
  } else if (event.type == "DISCONNECT") {
    deviceDisconnected();
  }
}

async function connectMoyuCube(device?: BluetoothDevice): Promise<SmartCubeConnection> {
  // Request device with filter for Moyu
  // We need to support both old and new Moyu UUIDs if possible, or just the new one.
  // Moyu32Cube uses '0783b03e-7735-b5a0-1760-a305d2795cb0'
  // MoyuCube uses '00001000-0000-1000-8000-00805f9b34fb'

  if (!device) {
    device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'MHC' }, { namePrefix: 'WCU' }, { namePrefix: 'Moyu' }],
      optionalServices: [
        '00001000-0000-1000-8000-00805f9b34fb',
        '0783b03e-7735-b5a0-1760-a305d2795cb0'
      ]
    });
  }

  // Determine which driver to use based on service UUIDs or name?
  // We can try to connect and see which service is present.
  // Or just check the name.
  // WCU_MY3... is likely Moyu32Cube.

  let conn: SmartCubeConnection;

  if (device.name && device.name.startsWith('WCU')) {
    conn = new Moyu32CubeConnection(device);
  } else {
    conn = new MoyuCubeConnection(device);
  }

  // If we have a saved MAC for this cube, set it.
  // But we don't know the ID yet unless we match by name?
  // The CubeManager manages saved cubes.
  // If the user connects a cube, we should check if it matches a saved cube.
  // Or we just use the connection.

  // For Moyu32, we need the MAC to init decoder.
  // If it's a new connection, we might not have the MAC.
  // Moyu32CubeConnection tries to handle it.

  return conn;
}



$('#input-alg').on('click', () => {
  twistyPlayer.experimentalStickering = 'full';
  twistyPlayer.alg = '';
  resetAlg();
  $('#alg-input').val('');
  inputMode = true;
  checkedAlgorithms = [];
  checkedAlgorithmsCopy = [];
  updateTimesDisplay();
  hideMistakes();
  scrambleMode = false;
  $('#alg-scramble').hide();
  $('#alg-help-info').hide();
  $('#alg-display-container').hide();
  $('#times-display').html('');
  $('#timer').hide();
  $('#alg-stats').hide();
  $('#alg-name-display-container').hide();
  $('#alg-input').show();
  $('#alg-input').get(0)?.focus();
  $('#app-top').show();
  $('#main-column').show();
  $('#help').hide();
  $('#options-container').hide();
  $('#load-container').hide();
  $('#save-container').hide();
  $('#info').hide();
  deactivateAttackMode();
  hideAttackLists();
});

$('#show-help').on('click', () => {
  $('#top-row').show();
  $('#main-column').hide();
  $('#help').show();
  $('#app-top').hide();
  $('#options-container').hide();
  $('#load-container').hide();
  $('#save-container').hide();
  $('#info').hide();
  $('#alg-stats').hide();
  $('#alg-name-display-container').hide();
  $('#alg-stats').hide();
  $('#alg-name-display-container').hide();
  deactivateAttackMode();
  hideAttackLists();
});

// Cube Menu Logic
let editingCubeId: string | null = null;

function detectCubeType(deviceName: string): 'GAN' | 'Moyu' {
  const name = deviceName.toUpperCase();
  if (name.startsWith('GAN') || name.startsWith('MGC') || name.startsWith('MG-')) {
    return 'GAN';
  } else if (name.startsWith('MHC') || name.startsWith('WCU')) {
    return 'Moyu';
  }
  // Default to GAN if uncertain
  return 'GAN';
}

function updateCubeMenu() {
  const list = $('#saved-cubes-list');
  list.empty();

  const cubes = cubeManager.getCubes();
  if (cubes.length === 0) {
    list.append('<div class="px-4 py-2 text-sm text-gray-500 italic dark:text-gray-400">No saved cubes</div>');
  } else {
    cubes.forEach(cube => {
      const item = $(`
        <div class="flex justify-between items-center px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-700">
          <button class="cube-connect-btn flex-1 text-left text-gray-700 dark:text-gray-300" data-cube-id="${cube.id}">
            <span>${cube.name} <span class="text-xs text-gray-500">(${cube.type})</span></span>
            ${cube.isDefault ? '<span class="text-green-500 text-xs font-bold ml-2">Default</span>' : ''}
          </button>
          <button class="cube-edit-btn p-1 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200" data-cube-id="${cube.id}">
            <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/>
            </svg>
          </button>
        </div>
      `);

      item.find('.cube-connect-btn').on('click', async () => {
        $('#cube-menu').addClass('hidden');
        await connectToCube(cube);
      });

      item.find('.cube-edit-btn').on('click', (e) => {
        e.stopPropagation();
        $('#cube-menu').addClass('hidden');
        openCubeModal(cube);
      });

      list.append(item);
    });
  }
}

function openCubeModal(cube?: SavedCube) {
  editingCubeId = cube?.id || null;

  if (cube) {
    $('#cube-modal-title').text('Edit Cube');
    $('#cube-name-input').val(cube.name);
    $('#cube-mac-input').val(cube.mac || '');
    $('#cube-default-checkbox').prop('checked', cube.isDefault);
    $('#cube-modal-save').text('SAVE');
    $('#cube-modal-delete').removeClass('hidden');
  } else {
    $('#cube-modal-title').text('Add Cube');
    $('#cube-name-input').val('');
    $('#cube-mac-input').val('');
    $('#cube-default-checkbox').prop('checked', false);
    $('#cube-modal-save').text('ADD CUBE');
    $('#cube-modal-delete').addClass('hidden');
  }

  $('#cube-modal').removeClass('hidden');
}

function closeCubeModal() {
  $('#cube-modal').addClass('hidden');
  editingCubeId = null;
}

$('#cube-menu-button').on('click', (e) => {
  e.stopPropagation();
  updateCubeMenu();
  $('#cube-menu').toggleClass('hidden');
});

$('#add-cube-button').on('click', () => {
  $('#cube-menu').addClass('hidden');
  openCubeModal();
});

$('#cube-modal-cancel').on('click', () => {
  closeCubeModal();
});

$('#cube-modal-delete').on('click', () => {
  if (editingCubeId && confirm('Are you sure you want to delete this cube?')) {
    cubeManager.deleteCube(editingCubeId);
    updateCubeMenu();
    closeCubeModal();
  }
});

// Algorithm Variants Modal Logic
let currentVariantsCase: { category: string, subset: string, caseName: string } | null = null;



function closeVariantsModal() {
  $('#alg-variants-modal').addClass('hidden');
  currentVariantsCase = null;
  // Reload algorithms to show updated favorites
  const category = $('#category-select').val() as string;
  if (category) {
    loadAlgorithms(category);
  }
}

// Save case details (rename/move)
$('#save-case-details-btn').on('click', () => {
  if (!currentVariantsCase) return;

  const newCaseName = $('#edit-case-name').val() as string;
  const newSubset = $('#edit-case-subset').val() as string;

  if (!newCaseName || !newSubset) {
    alert('Case Name and Subset cannot be empty.');
    return;
  }

  const { category, subset: oldSubset, caseName: oldCaseName } = currentVariantsCase;

  // If nothing changed, do nothing
  if (newCaseName === oldCaseName && newSubset === oldSubset) {
    return;
  }

  const savedAlgorithms = JSON.parse(localStorage.getItem('savedAlgorithms') || '{}');
  const categoryData = savedAlgorithms[category];

  if (!categoryData) return;

  // Find the case
  const caseIndex = categoryData.findIndex((c: any) => c.subset === oldSubset && c.case === oldCaseName);

  if (caseIndex !== -1) {
    // Check if target case already exists (merge?)
    const targetCaseIndex = categoryData.findIndex((c: any) => c.subset === newSubset && c.case === newCaseName);

    if (targetCaseIndex !== -1 && targetCaseIndex !== caseIndex) {
      if (!confirm(`Case "${newCaseName}" in subset "${newSubset}" already exists. Merge algorithms?`)) {
        return;
      }
      // Merge algorithms
      const sourceAlgs = categoryData[caseIndex].algorithms;
      categoryData[targetCaseIndex].algorithms.push(...sourceAlgs);
      // Remove old case
      categoryData.splice(caseIndex, 1);
    } else {
      // Just update the case
      categoryData[caseIndex].case = newCaseName;
      categoryData[caseIndex].subset = newSubset;
    }

    localStorage.setItem('savedAlgorithms', JSON.stringify(savedAlgorithms));

    // Update current context
    currentVariantsCase = { category, subset: newSubset, caseName: newCaseName };
    $('#alg-variants-title').text(`${newCaseName} - Algorithm Variants`);

    alert('Case details updated.');

    // Refresh variants list (in case we merged)
    openVariantsModal(category, newSubset, newCaseName);
  }
});

let editingVariantId: string | null = null;

function openVariantsModal(category: string, subset: string, caseName: string) {
  $('#alg-variants-modal').removeClass('hidden');
  currentVariantsCase = { category, subset, caseName };
  $('#alg-variants-title').text(`${caseName} - Algorithm Variants`);

  // Populate edit fields
  $('#edit-case-name').val(caseName);
  $('#edit-case-subset').val(subset);

  // Load and display all variants
  const savedAlgorithms = JSON.parse(localStorage.getItem('savedAlgorithms') || '{}');

  // Populate subset helper dropdown
  const categoryData = savedAlgorithms[category];
  if (categoryData) {
    const subsets = [...new Set(categoryData.map((c: any) => c.subset))];
    const select = $('#existing-subsets');
    select.empty();
    select.append('<option value="">Select...</option>');
    subsets.forEach((s: any) => {
      select.append(`<option value="${s}">${s}</option>`);
    });

    // Add change listener to update input
    select.off('change').on('change', function () {
      const selected = $(this).val() as string;
      if (selected) {
        $('#edit-case-subset').val(selected);
        // Reset select so the same value can be selected again if needed
        $(this).val('');
      }
    });
  }

  const caseData = savedAlgorithms[category]?.find((c: any) => c.subset === subset && c.case === caseName);

  if (caseData) {
    const variantsList = $('#alg-variants-list');
    variantsList.empty();

    caseData.algorithms.forEach((alg: any) => {
      const isFavorite = alg.isFavorite;
      const starIcon = isFavorite ? '⭐' : '☆';
      const youtube = alg.youtubeUrl as string | undefined;

      variantsList.append(`
        <div class="bg-gray-700 rounded-lg p-3 variant-item" draggable="true" data-variant-id="${alg.id}">
          <div class="flex justify-between items-start mb-2">
            <div>
              <span class="font-semibold text-white">${alg.name}</span>
              <button class="ml-2 text-2xl hover:scale-110 transition-transform" data-alg-id="${alg.id}" onclick="toggleFavorite('${alg.id}')">${starIcon}</button>
            </div>
            <div class="flex items-center gap-2">
              <button class="text-blue-300 hover:text-blue-100 text-sm" onclick="editVariant('${alg.id}')">Edit</button>
              ${!isFavorite ? `<button class="text-red-400 hover:text-red-300 text-sm" onclick="deleteVariant('${alg.id}')">Delete</button>` : ''}
            </div>
          </div>
          <div class="text-sm text-gray-300 font-mono break-all mb-2">${alg.algorithm}</div>
          <div class="flex flex-wrap items-center gap-4 text-xs text-gray-400 font-mono border-t border-gray-600 pt-2">
             <div>Best: <span class="text-white">${bestTimeString(bestTimeNumber(algToId(alg.algorithm)))}</span></div>
             <div>Ao5: <span class="text-white">${averageTimeString(averageOfFiveTimeNumber(algToId(alg.algorithm)))}</span></div>
             ${youtube ? `<a href="${youtube}" target="_blank" class="text-red-400 hover:text-red-300 underline">YouTube</a>` : ''}
          </div>
        </div>
      `);
    });
  }

  // Clear add variant inputs
  $('#new-variant-name').val('');
  $('#new-variant-alg').val('');
  $('#new-variant-youtube').val('');
  editingVariantId = null;
  $('#add-variant-btn').text('Add Variant');
}

// Make functions global for onclick handlers
(window as any).toggleFavorite = (algorithmId: string) => {
  if (!currentVariantsCase) return;

  const { category, subset, caseName } = currentVariantsCase;

  // Remember currently selected cases (by name)
  const selectedCaseNames = checkedAlgorithms.map((a) => a.name);

  // Import setFavoriteAlgorithm dynamically and update the favorite variant
  import('./functions').then(({ setFavoriteAlgorithm }) => {
    setFavoriteAlgorithm(category, subset, caseName, algorithmId);

    // Read the newly set favorite algorithm from localStorage
    const savedAlgorithms = JSON.parse(localStorage.getItem('savedAlgorithms') || '{}');
    const categoryData = savedAlgorithms[category];
    const caseData = categoryData?.find((c: any) => c.subset === subset && c.case === caseName);
    const favoriteAlg = caseData?.algorithms.find((a: any) => a.isFavorite);
    const expandedFavoriteAlg = favoriteAlg ? expandNotation(favoriteAlg.algorithm) : null;

    // After changing the favorite variant, immediately switch the currently trained algorithm
    if (expandedFavoriteAlg) {
      $('#alg-input').val(expandedFavoriteAlg);
      currentAlgName = caseName;
      $('#train-alg').trigger('click');
    }

    // If the same category is currently selected – reload the cards and restore selections
    const currentCategory = $('#category-select').val() as string;
    if (currentCategory === category) {
      loadAlgorithms(category);

      // Re-check previously selected cases (by name)
      $('#alg-cases input[type="checkbox"]').each(function () {
        const name = $(this).data('name');
        if (selectedCaseNames.includes(name)) {
          $(this).prop('checked', true).trigger('change');
        }
      });
    }

    // Reload the variants modal to refresh the favorite star icons
    openVariantsModal(category, subset, caseName);
  });
};

(window as any).editVariant = (algorithmId: string) => {
  if (!currentVariantsCase) return;

  const { category, subset, caseName } = currentVariantsCase;
  const savedAlgorithms = JSON.parse(localStorage.getItem('savedAlgorithms') || '{}');
  const caseData = savedAlgorithms[category]?.find((c: any) => c.subset === subset && c.case === caseName);
  if (!caseData) return;

  const variant = caseData.algorithms.find((a: any) => a.id === algorithmId);
  if (!variant) return;

  editingVariantId = algorithmId;
  $('#new-variant-name').val(variant.name || '');
  $('#new-variant-alg').val(variant.algorithm || '');
  $('#new-variant-youtube').val(variant.youtubeUrl || '');
  $('#add-variant-btn').text('Save Changes');
};

// Drag & drop reordering for algorithm variants
let draggedVariantId: string | null = null;

$('#alg-variants-list').on('dragstart', '.variant-item', function (event) {
  const id = $(this).data('variant-id') as string | undefined;
  if (!id) return;
  draggedVariantId = id;
  $(this).addClass('opacity-50');
  const dt = (event.originalEvent as DragEvent).dataTransfer;
  if (dt) {
    dt.effectAllowed = 'move';
    dt.setData('text/plain', id);
  }
});

$('#alg-variants-list').on('dragend', '.variant-item', function () {
  draggedVariantId = null;
  $(this).removeClass('opacity-50');
});

$('#alg-variants-list').on('dragover', '.variant-item', function (event) {
  event.preventDefault();
  const dt = (event.originalEvent as DragEvent).dataTransfer;
  if (dt) {
    dt.dropEffect = 'move';
  }
});

$('#alg-variants-list').on('drop', '.variant-item', function (event) {
  event.preventDefault();
  if (!currentVariantsCase) return;

  const targetId = $(this).data('variant-id') as string | undefined;
  const dt = (event.originalEvent as DragEvent).dataTransfer;
  const sourceId = draggedVariantId || (dt ? dt.getData('text/plain') : null);

  if (!sourceId || !targetId || sourceId === targetId) return;

  const { category, subset, caseName } = currentVariantsCase;
  reorderAlgorithmVariants(category, subset, caseName, sourceId, targetId);
  // Re-open modal to refresh order
  openVariantsModal(category, subset, caseName);
});

// ------------------------------
// Attack lists (PLL & OLL) with drag & drop reordering
// ------------------------------

let attackDraggedKey: string | null = null;
let attackDraggedCategory: AttackCategory | null = null;
let attackDropAfter: boolean = false;

function buildAttackQueue(category: AttackCategory): Algorithm[] {
  const queue: Algorithm[] = [];

  const raw = localStorage.getItem('savedAlgorithms') || '{}';
  let savedAlgorithms: any = {};
  try {
    savedAlgorithms = JSON.parse(raw);
  } catch {
    savedAlgorithms = {};
  }

  const cases = savedAlgorithms[category] as any[] | undefined;
  if (!cases || cases.length === 0) {
    return queue;
  }

  cases.forEach((caseData: any) => {
    if (!caseData || !Array.isArray(caseData.algorithms) || caseData.algorithms.length === 0) {
      return;
    }
    const favoriteAlg = caseData.algorithms.find((a: any) => a.isFavorite) || caseData.algorithms[0];
    if (!favoriteAlg) return;

    const expandedAlg = expandNotation(favoriteAlg.algorithm || '');
    const algId = algToId(expandedAlg);
    const best = bestTimeNumber(algId) || 0;

    queue.push({
      algorithm: expandedAlg,
      name: caseData.case || '',
      bestTime: best,
      subset: caseData.subset || '',
      category
    });
  });

  return queue;
}

function renderAttackList(category: AttackCategory) {
  const config = ATTACK_CONFIG[category];
  const list = $(config.listSelector);
  if (list.length === 0) return;

  list.empty();

  const raw = localStorage.getItem('savedAlgorithms') || '{}';
  let savedAlgorithms: any = {};
  try {
    savedAlgorithms = JSON.parse(raw);
  } catch {
    savedAlgorithms = {};
  }

  const cases = savedAlgorithms[category] as any[] | undefined;
  if (!cases || cases.length === 0) {
    list.append(`<div class="px-4 py-2 text-sm text-gray-500 dark:text-gray-400 italic">No ${category} algorithms found.</div>`);
    return;
  }

  cases.forEach((caseData: any) => {
    if (!caseData || !Array.isArray(caseData.algorithms) || caseData.algorithms.length === 0) {
      return;
    }

    const favoriteAlg = caseData.algorithms.find((a: any) => a.isFavorite) || caseData.algorithms[0];
    if (!favoriteAlg) return;

    const key = `${caseData.subset || ''}::${caseData.case || ''}`;
    const subsetLabel = caseData.subset || '';
    const caseName = caseData.case || '';
    const algText = expandNotation(favoriteAlg.algorithm || '');

    list.append(`
      <div class="attack-item flex items-center justify-between px-4 py-2 cursor-move hover:bg-gray-100 dark:hover:bg-gray-700"
           draggable="true"
           data-category="${category}"
           data-key="${key}"
           data-subset="${subsetLabel}"
           data-case="${caseName}">
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2">
            <span class="font-semibold truncate">${caseName}</span>
            ${subsetLabel ? `<span class="text-[10px] px-2 py-0.5 rounded-full bg-blue-500 text-white uppercase tracking-wide">${subsetLabel}</span>` : ''}
          </div>
          <div class="mt-1 text-[11px] font-mono text-gray-700 dark:text-gray-300 break-all">${algText}</div>
        </div>
        <div class="ml-3 text-gray-400 dark:text-gray-500 flex items-center justify-center">
          &#9776;
        </div>
      </div>
    `);
  });
}

$('.attack-list').on('dragstart', '.attack-item', function (event) {
  const key = $(this).data('key') as string | undefined;
  const category = $(this).data('category') as AttackCategory | undefined;
  if (!key || !category) return;

  attackDraggedKey = key;
  attackDraggedCategory = category;
  $(this).addClass('opacity-50');

  const dt = (event.originalEvent as DragEvent).dataTransfer;
  if (dt) {
    dt.effectAllowed = 'move';
    dt.setData('text/plain', key);
  }
});

$('.attack-list').on('dragend', '.attack-item', function () {
  attackDraggedKey = null;
  attackDraggedCategory = null;
  $(this).removeClass('opacity-50');
  $('.attack-item').removeClass('border-t-2 border-b-2 border-blue-500');
});

$('.attack-list').on('dragover', '.attack-item', function (event) {
  event.preventDefault();
  const dt = (event.originalEvent as DragEvent).dataTransfer;
  if (dt) {
    dt.dropEffect = 'move';
  }

  const $item = $(this);
  const offsetTop = $item.offset()?.top ?? 0;
  const height = $item.outerHeight() ?? 0;
  const clientY = (event.originalEvent as DragEvent).clientY;
  const isBefore = clientY < offsetTop + height / 2;

  // Visual indicator: thin blue line above or below target item
  $('.attack-item').removeClass('border-t-2 border-b-2 border-blue-500');
  if (isBefore) {
    $item.addClass('border-t-2 border-blue-500').removeClass('border-b-2');
    attackDropAfter = false;
  } else {
    $item.addClass('border-b-2 border-blue-500').removeClass('border-t-2');
    attackDropAfter = true;
  }
});

$('.attack-list').on('drop', '.attack-item', function (event) {
  event.preventDefault();

  const targetKey = $(this).data('key') as string | undefined;
  const category = $(this).data('category') as AttackCategory | undefined;
  const dt = (event.originalEvent as DragEvent).dataTransfer;
  const sourceKey = attackDraggedKey || (dt ? dt.getData('text/plain') : null);

  if (!sourceKey || !targetKey || sourceKey === targetKey || !category) return;
  if (attackDraggedCategory && attackDraggedCategory !== category) return;

  const [sourceSubset, sourceCase] = (sourceKey as string).split('::');
  const [targetSubset, targetCase] = (targetKey as string).split('::');

  reorderCasesInCategory(category, sourceSubset || '', sourceCase || '', targetSubset || '', targetCase || '', attackDropAfter);
  renderAttackList(category);
  // Clear visual indicators
  $('.attack-item').removeClass('border-t-2 border-b-2 border-blue-500');
  if (attackModeCategory === category) {
    attackQueue = buildAttackQueue(category);
    attackIndex = 0;
  }
});

(window as any).deleteVariant = (algorithmId: string) => {
  if (!currentVariantsCase) return;
  if (!confirm('Delete this algorithm variant?')) return;

  const savedAlgorithms = JSON.parse(localStorage.getItem('savedAlgorithms') || '{}');
  const { category, subset, caseName } = currentVariantsCase;
  const caseData = savedAlgorithms[category]?.find((c: any) => c.subset === subset && c.case === caseName);

  if (caseData) {
    // Find the algorithm to delete
    const algToDelete = caseData.algorithms.find((a: any) => a.id === algorithmId);
    if (algToDelete) {
      deleteAlgorithm(category, algToDelete.algorithm);
      // Reload modal
      openVariantsModal(category, subset, caseName);
    }
  }
};

$('#alg-variants-close').on('click', closeVariantsModal);

$('#add-variant-btn').on('click', () => {
  if (!currentVariantsCase) return;

  const variantName = $('#new-variant-name').val()?.toString().trim() || '';
  const variantAlg = $('#new-variant-alg').val()?.toString().trim() || '';
  const youtubeUrl = $('#new-variant-youtube').val()?.toString().trim() || '';

  if (!variantName || !variantAlg) {
    alert('Please enter both variant name and algorithm');
    return;
  }

  const { category, subset, caseName } = currentVariantsCase;

  if (editingVariantId) {
    // Update existing variant
    updateAlgorithmVariant(category, subset, caseName, editingVariantId, expandNotation(variantAlg), variantName, youtubeUrl);
  } else {
    // Add new variant
    saveAlgorithm(category, subset, caseName, expandNotation(variantAlg), variantName, false, youtubeUrl);
  }

  // Reload modal and reset editing state
  openVariantsModal(category, subset, caseName);
});

// Add click handler for case cards to open variants modal
// Add click handler for edit button to open variants modal
$(document).on('click', '.edit-alg-btn', function (e) {
  e.stopPropagation();

  const category = $(this).data('category');
  const subset = $(this).data('subset');
  const caseName = $(this).data('case');

  if (category && subset && caseName) {
    openVariantsModal(category, subset, caseName);
  }
});

$('#cube-modal-save').on('click', async () => {
  const name = $('#cube-name-input').val() as string;
  const mac = ($('#cube-mac-input').val() as string) || null;
  const isDefault = $('#cube-default-checkbox').prop('checked');

  if (!name.trim()) {
    alert('Please enter a cube name');
    return;
  }

  if (editingCubeId) {
    // Editing existing cube
    cubeManager.updateCube(editingCubeId, { name, mac, isDefault });
    closeCubeModal();
  } else {
    // Adding new cube - initiate connection to detect type
    closeCubeModal();

    try {
      // Request Bluetooth device
      const device = await navigator.bluetooth.requestDevice({
        filters: [
          { namePrefix: 'GAN' },
          { namePrefix: 'MG' },
          { namePrefix: 'MGC' },
          { namePrefix: 'MHC' },
          { namePrefix: 'WCU' }
        ],
        optionalServices: [
          '0000aadb-0000-1000-8000-00805f9b34fb',
          '0000aadc-0000-1000-8000-00805f9b34fb',
          '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
          '0783b03e-7735-b5a0-1760-a305d2795cb0'
        ]
      });

      const detectedType = detectCubeType(device.name || '');

      // Derive MAC address for Moyu cubes from device name, leave null for others
      let detectedMac: string | null = null;
      if (detectedType === 'Moyu' && device.name && /^WCU_MY32_[0-9A-F]{4}$/.exec(device.name)) {
        detectedMac = 'CF:30:16:00:' + device.name.slice(9, 11) + ':' + device.name.slice(11, 13);
        console.log('Derived MAC from device name:', detectedMac);
      } else if (mac) {
        // User provided MAC in the modal
        detectedMac = mac;
      }

      // Save cube
      cubeManager.addCube(name, detectedMac, detectedType, isDefault);

      // Connect
      let conn: SmartCubeConnection;
      if (detectedType === 'GAN') {
        conn = await connectGanCube() as any;
      } else {
        conn = await connectMoyuCube(device);
      }
      await handleConnection(conn, detectedType);
    } catch (error) {
      console.error('Error adding cube:', error);
      alert('Failed to connect to cube. Please try again.');
    }
  }
});

$('#cube-modal').on('click', (e) => {
  if (e.target.id === 'cube-modal') {
    closeCubeModal();
  }
});

$(document).on('click', (e) => {
  if (!$(e.target).closest('#cube-menu-button').length && !$(e.target).closest('#cube-menu').length) {
    $('#cube-menu').addClass('hidden');
  }
});

$('#device-info').on('click', () => {
  const infoDiv = $('#info');
  if (infoDiv.css('display') === 'none') {
    infoDiv.css('display', 'grid');
    $('#options-container').hide();
    $('#load-container').hide();
    $('#save-container').hide();
    $('#help').hide();
    deactivateAttackMode();
    hideAttackLists();
  } else {
    infoDiv.css('display', 'none');
  }
});

$('#reset-state').on('click', async () => {
  await conn?.sendCubeCommand({ type: "REQUEST_RESET" });
  twistyPlayer.alg = '';
  twistyTracker.alg = '';
  drawAlgInCube();
});

$('#reset-gyro').on('click', async () => {
  basis = null;
});

function deviceDisconnected() {
  conn = null;
  twistyPlayer.alg = '';
  twistyTracker.alg = '';
  releaseWakeLock();
  $('#reset-gyro').prop('disabled', true);
  $('#reset-state').prop('disabled', true);
  $('#device-info').prop('disabled', true);
  $('.info input').val('- n/a -');
  $('#connect-text').text('Connect');
  $('#battery-indicator').addClass('hidden');
  $('#bluetooth-indicator').addClass('hidden');
}

$('#connect-button').on('click', async () => {
  try {
    // Check if already connected - if so, disconnect
    if (conn) {
      conn.disconnect();
      deviceDisconnected();
      return;
    }

    // Check if we have a default cube
    const defaultCube = cubeManager.getDefaultCube();

    if (defaultCube) {
      // Connect to default cube
      await connectToCube(defaultCube);
    } else {
      // No saved cubes, prompt user to choose cube type manually
      const choice = prompt("Choose cube type:\n1. Gan\n2. Moyu");
      if (choice === '1') {
        const conn = await connectGanCube() as any;
        await handleConnection(conn, 'GAN');
      } else if (choice === '2') {
        const conn = await connectMoyuCube();
        await handleConnection(conn, 'Moyu');
      }
    }
  } catch (err) {
    console.error('Connection error:', err);
  }
});

async function connectToCube(cube: SavedCube) {
  let conn: SmartCubeConnection;
  if (cube.type === 'GAN') {
    // We need to pass the MAC if available to connectGanCube?
    // connectGanCube currently requests device.
    // We might need to modify it to accept a device or ID?
    // For now, just call it, it will prompt.
    conn = await connectGanCube() as any;
    await handleConnection(conn, 'GAN');
  } else {
    conn = await connectMoyuCube();
    if (conn instanceof Moyu32CubeConnection && cube.mac) {
      conn.setMacAddress(cube.mac);
    }
    await handleConnection(conn, cube.type);
  }
}

async function handleConnection(connection: SmartCubeConnection, type: 'GAN' | 'Moyu') {
  conn = connection;
  conn.type = type;

  // Connect to the cube if it's a Moyu cube (needs explicit connect call)
  if (connection instanceof Moyu32CubeConnection || connection instanceof MoyuCubeConnection) {
    await connection.connect();
  }

  $('#connect-text').text('Disconnect');
  $('#bluetooth-indicator').removeClass('hidden');

  // Check if cube is already saved, if not, prompt to save
  const existingCube = cubeManager.getCubes().find(c => c.name === connection.deviceName || (connection.deviceMAC && c.mac === connection.deviceMAC));

  if (!existingCube) {
    const shouldSave = confirm(`Save this cube (${conn.deviceName}) for future use?`);
    if (shouldSave) {
      const name = prompt('Enter a name for this cube:', conn.deviceName || `My ${type} Cube`);
      if (name) {
        cubeManager.addCube(name, conn.deviceMAC || null, type, true);
        updateCubeMenu();
      }
    }
  }

  conn.events$.subscribe(handleCubeEvent);

  $('#reset-gyro').prop('disabled', false);
  $('#reset-state').prop('disabled', false);
  $('#device-info').prop('disabled', false);

  // Battery handling
  // Initial battery check if possible
  if (type === 'Moyu') {
    // Moyu sends battery automatically
  }

  // Update device info
  $('#device-name').val(conn.deviceName);
  $('#device-mac').val(conn.deviceMAC || 'Unknown');
  $('#device-type').val(conn.type);

  // Handle disconnect
  if ((conn as any).device?.gatt) {
    (conn as any).device.addEventListener('gattserverdisconnected', deviceDisconnected);
  }
}

var timerState: "IDLE" | "READY" | "RUNNING" | "STOPPED" = "IDLE";

function updateTimesDisplay() {
  const timesDisplay = $('#times-display');
  const algNameDisplay = $('#alg-name-display');
  const algNameDisplay2 = $('#alg-name-display2');
  const attackContext = getAttackContextCategory();
  const algId = attackContext ? ATTACK_CONFIG[attackContext].sessionId : algToId(originalUserAlg.join(' '));

  // Use the new function to get last times
  const lastTimes = getLastTimes(algId);
  const bestTime = bestTimeNumber(algId);

  const displayName = attackContext ? ATTACK_CONFIG[attackContext].label : currentAlgName;
  algNameDisplay.text(showAlgNameEnabled ? displayName : '');
  algNameDisplay2.text(showAlgNameEnabled ? displayName : '');

  createTimeGraph(lastTimes.slice(-5));
  createStatsGraph(lastTimes);

  // Calculate average time
  const averageTime = lastTimes.reduce((a: number, b: number) => a + b, 0) / lastTimes.length;
  $('#average-time-box').html(`Average Time<br />${averageTimeString(averageTime)}`);

  // Calculate average TPS
  const moveCount = countMovesETM(userAlg.join(' '));
  const averageTPS = averageTime ? (moveCount / (averageTime / 1000)).toFixed(2) : '-';
  $('#average-tps-box').html(`Average TPS<br />${averageTPS}`);

  // check if the last item added to lastTimes is a PB
  const lastTime = lastTimes.slice(-1)[0];
  const isPB = lastTime === bestTime;

  // Get single PB
  const singlePB = isPB ? `${bestTimeString(bestTime)} 🎉` : bestTimeString(bestTime);
  $('#single-pb-box').html(`Single PB<br />${singlePB}`);


  if (lastTimes.length === 0) {
    timesDisplay.html('');
    $('#alg-stats').hide();
    $('#alg-name-display-container').hide();
    return;
  }

  const practiceCount: number = $('#' + algId).data('count') || 0;
  const timesHtml = lastTimes.slice(-5).map((time: number, index: number) => {
    const t = makeTimeFromTimestamp(time);
    let number = practiceCount < 5 ? index + 1 : practiceCount - 5 + index + 1;
    // Add emoji if the time is a PB
    const emojiPB = time === bestTime ? ' 🎉' : '';
    const minutesPart = t.minutes > 0 ? `${t.minutes}:` : '';
    return `<div class="text-right">Time ${number}:</div><div class="text-left">${minutesPart}${t.seconds.toString(10).padStart(2, '0')}.${t.milliseconds.toString(10).padStart(3, '0')}${emojiPB}</div>`;
  }).join('');

  const avgTime = averageOfFiveTimeNumber(algId) ?? 0;
  let averageHtml = '';
  if (avgTime > 0) {
    const avg = makeTimeFromTimestamp(avgTime);
    const avgMinutesPart = avg.minutes > 0 ? `${avg.minutes}:` : '';
    averageHtml = `<div id="average" class="font-bold text-right">Ao5:</div><div class="font-bold text-left">${avgMinutesPart}${avg.seconds.toString(10).padStart(2, '0')}.${avg.milliseconds.toString(10).padStart(3, '0')}</div>`;
  } else {
    averageHtml = `<div id="average" class="font-bold text-right">Ao5:</div><div class="font-bold text-left">-</div>`;
  }

  let bestTimeHtml = '';
  if (bestTime) {
    const best = makeTimeFromTimestamp(bestTime);
    const bestMinutesPart = best.minutes > 0 ? `${best.minutes}:` : '';
    bestTimeHtml = `<div id="best" class="text-right">Best:</div><div class="text-left">${bestMinutesPart}${best.seconds.toString(10).padStart(2, '0')}.${best.milliseconds.toString(10).padStart(3, '0')}</div>`;
  }

  const displayHtml = `<div class="grid grid-cols-2 items-center gap-1 pt-2">${timesHtml}${averageHtml}${bestTimeHtml}</div>`;
  timesDisplay.html(displayHtml);
}

function setTimerState(state: typeof timerState) {
  timerState = state;
  const attackContext = getAttackContextCategory();
  const algId = attackContext ? ATTACK_CONFIG[attackContext].sessionId : algToId(originalUserAlg.join(' '));
  // check if the algId exists in the DOM, create it if it doesn't
  if ($('#' + algId).length === 0) {
    $('#default-alg-id').append(`<div id="${algId}" class="hidden"></div>`);
  }
  let practiceCount = $('#' + algId).data('count') || 0;

  switch (state) {
    case "IDLE":
      stopLocalTimer();
      $('#timer').hide();
      $('#train-alg').html('<svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>');
      break;
    case 'READY':
      stopLocalTimer();
      let timerText = $('#timer').text();
      if (timerText === '') {
        setTimerValue(0);
      }
      $('#timer').show();
      $('#timer').css('color', '#080');
      $('#train-alg').html('<svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>');
      break;
    case 'RUNNING':
      solutionMoves = [];
      startLocalTimer();
      $('#timer').css('color', '#999');
      $('#train-alg').html('<svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="currentColor" viewBox="0 0 32 32"><path d="M8 8h16v16H8z"/></svg>');
      break;
    case 'STOPPED':
      let finalTime = currentTimerValue;
      stopLocalTimer();
      let stoppedcolor = darkModeToggle.checked ? '#ccc' : '#333';
      $('#timer').css('color', stoppedcolor);
      if (conn) {
        const fittedMoves = cubeTimestampLinearFit(solutionMoves as any);
        const firstMove = fittedMoves[0];
        const lastMove = fittedMoves.slice(-1).pop();
        if (
          firstMove &&
          lastMove &&
          typeof lastMove.cubeTimestamp === 'number' &&
          typeof firstMove.cubeTimestamp === 'number'
        ) {
          const duration = lastMove.cubeTimestamp - firstMove.cubeTimestamp;
          if (duration > 0) {
            finalTime = duration;
          }
        }
      }
      // Fallback: ensure we never store/display a negative or zero time
      if (finalTime <= 0) {
        finalTime = currentTimerValue;
      }
      setTimerValue(finalTime);
      $('#train-alg').html('<svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>');

      // Store the time and update the display
      if (finalTime > 0) {
        const lastTimesStorage = localStorage.getItem('LastTimes-' + algId);
        var lastTimes: number[] = []
        if (lastTimesStorage) {
          lastTimes = lastTimesStorage.split(',').map(num => Number(num.trim()));
        }
        lastTimes.push(finalTime);
        if (lastTimes.length > 100) {
          lastTimes.shift(); // Keep only the last 100 times
        }
        practiceCount++; // Increment the practice count

        localStorage.setItem('LastTimes-' + algId, lastTimes.join(','));
        $('#' + algId).data('count', practiceCount);

        const bestTime = localStorage.getItem('Best-' + algId);
        if (!bestTime || finalTime < Number(bestTime)) {
          localStorage.setItem('Best-' + algId, String(finalTime));
          $('#best-time-' + algId).html(`Best: ${bestTimeString(finalTime)}`);
        }
        $('#ao5-time-' + algId).html(`Ao5: ${averageTimeString(averageOfFiveTimeNumber(algId))}`);

        //console.log("[setTimerState] Setting lastTimes to " + lastTimes + " for algId " + algId);
        //console.log("[setTimerState] Setting practiceCount to " + practiceCount + " for algId " + algId);

        let failedCount: number = $('#' + algId).data('failed') || 0;
        if (failedCount < 0) failedCount = 0;
        if (practiceCount < failedCount) failedCount = practiceCount;
        let successCount: number = practiceCount - failedCount;
        $('#' + algId + '-success').html(`✅: ${successCount}`);
        if (failedCount > 0) $('#' + algId + '-failed').html(`❌: ${failedCount}`);

        // Always refresh the stats panel
        updateTimesDisplay();

        // For non-smart cubes, auto-advance to the next case here.
        if (!conn) {
          switchToNextAlgorithm();
          if (checkedAlgorithms.length > 0) {
            const nextAlgorithm = refreshCheckedAlgorithmAt(0);
            if (nextAlgorithm) {
              $('#alg-input').val(nextAlgorithm);
            }
          }
          $('#train-alg').trigger('click');
        }
      }
      break;
  }
}

var myKpattern: KPattern;
var initialstate: KPattern;

twistyTracker.experimentalModel.currentPattern.addFreshListener(async (kpattern) => {
  myKpattern = kpattern;
  if (patternStates.length > 0 && currentMoveIndex === 0 && myKpattern.isIdentical(initialstate)) {
    console.log("Returning to initial state")
    resetAlg();
    updateAlgDisplay();
  }
});

function setTimerValue(timestamp: number) {
  let t = makeTimeFromTimestamp(timestamp);
  $('#timer').html(`${t.minutes}:${t.seconds.toString(10).padStart(2, '0')}.${t.milliseconds.toString(10).padStart(3, '0')}`);
}

let currentTimerValue = 0;
var localTimer: Subscription | null = null;
function startLocalTimer() {
  var startTime = now();
  localTimer = interval(30).subscribe(() => {
    currentTimerValue = now() - startTime;
    setTimerValue(currentTimerValue);
  });
}

function stopLocalTimer() {
  localTimer?.unsubscribe();
  localTimer = null;
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (confirm('New version available. Refresh now?')) {
      window.location.reload();
    }
  });
}

// Call the function to initialize default algorithms
initializeDefaultAlgorithms();

interface Algorithm {
  algorithm: string;
  name: string;
  bestTime: number;
  subset?: string;
  category?: string;
}

let checkedAlgorithms: Algorithm[] = [];
let checkedAlgorithmsCopy: Algorithm[] = [];
let currentAlgName: string = '';

function resolveFavoriteAlgorithmForCase(
  category?: string,
  subset?: string,
  caseName?: string
): { algorithm: string; bestTime: number } | null {
  if (!category || !subset || !caseName) {
    return null;
  }

  const raw = localStorage.getItem('savedAlgorithms') || '{}';
  let savedAlgorithms: any = {};
  try {
    savedAlgorithms = JSON.parse(raw);
  } catch {
    return null;
  }

  const cases = savedAlgorithms[category];
  if (!Array.isArray(cases)) {
    return null;
  }

  const caseData = cases.find((c: any) => c.subset === subset && c.case === caseName);
  if (!caseData || !Array.isArray(caseData.algorithms) || caseData.algorithms.length === 0) {
    return null;
  }

  const favoriteAlg = caseData.algorithms.find((a: any) => a.isFavorite) || caseData.algorithms[0];
  if (!favoriteAlg || !favoriteAlg.algorithm) {
    return null;
  }

  const expandedAlg = expandNotation(favoriteAlg.algorithm);
  const algId = algToId(expandedAlg);
  const best = bestTimeNumber(algId) || 0;
  return { algorithm: expandedAlg, bestTime: best };
}

function refreshCheckedAlgorithmAt(index: number): string | null {
  const entry = checkedAlgorithms[index];
  if (!entry) return null;

  const resolved = resolveFavoriteAlgorithmForCase(entry.category, entry.subset, entry.name);
  if (resolved) {
    entry.algorithm = resolved.algorithm;
    entry.bestTime = resolved.bestTime;
    return entry.algorithm;
  }

  return entry.algorithm || null;
}

// Collect checked algorithms using event delegation
$('#alg-cases').on('change', 'input[type="checkbox"]', function () {
  const algorithm = $(this).data('algorithm');
  const name = $(this).data('name');
  const bestTime = Number($(this).data('best') ?? 0);
  const subset = $(this).data('subset');
  const category = $(this).data('category');
  if ((this as HTMLInputElement).checked) {
    const favorite = resolveFavoriteAlgorithmForCase(category, subset, name);
    const currentAlg: Algorithm = {
      algorithm: favorite?.algorithm || algorithm,
      name,
      bestTime: favorite?.bestTime ?? bestTime ?? 0,
      subset,
      category
    };
    if (prioritizeSlowAlgs) {
      const index = (!bestTime)
        ? checkedAlgorithms.reduceRight((lastIndex, alg, i) => !alg.bestTime ? lastIndex : i, -1)
        : checkedAlgorithms.findIndex(alg => alg.bestTime && alg.bestTime < bestTime);
      if (index === -1) {
        checkedAlgorithms.push(currentAlg);
      } else {
        checkedAlgorithms.splice(index, 0, currentAlg);
      }
    } else {
      checkedAlgorithms.push(currentAlg);
    }
  } else {
    // remove all occurrences of this case from checkedAlgorithms and checkedAlgorithmsCopy
    checkedAlgorithms = checkedAlgorithms.filter(alg => !(alg.name === name && alg.subset === subset && alg.category === category));
    checkedAlgorithmsCopy = checkedAlgorithmsCopy.filter(alg => !(alg.name === name && alg.subset === subset && alg.category === category));
  }
  if (checkedAlgorithms.length > 0) {
    const nextAlgorithm = refreshCheckedAlgorithmAt(0);
    if (nextAlgorithm) {
      $('#alg-input').val(nextAlgorithm);
      const isSameCase = checkedAlgorithms[0].name === name
        && checkedAlgorithms[0].subset === subset
        && checkedAlgorithms[0].category === category;
      if (isSameCase) {
        $('#train-alg').trigger('click');
      }
    }
    // if the checkbox has been unchecked trigger a click on the train button
    if (!((this as HTMLInputElement).checked)) {
      $('#train-alg').trigger('click');
    }
  } else {
    resetDrill();
  }
  //console.log("checkedAlgorithms: " + JSON.stringify(checkedAlgorithms));
  //console.log("checkedAlgorithmsCopy: " + JSON.stringify(checkedAlgorithmsCopy));
});

// Event listener for Delete Mode toggle
$('#delete-mode-toggle').on('change', () => {
  const isDeleteModeOn = $('#delete-mode-toggle').is(':checked');
  $('#delete-alg').prop('disabled', !isDeleteModeOn);
  $('#delete-times').prop('disabled', !isDeleteModeOn);
});

$('#delete-times').on('click', () => {
  if (confirm('Are you sure you want to remove the times for the selected algorithms?')) {
    const category = $('#category-select').val()?.toString() || '';
    for (const algorithm of checkedAlgorithms) {
      if (algorithm) {
        const algId = algToId(algorithm.algorithm);
        localStorage.removeItem('Best-' + algId);
        localStorage.removeItem('LastTimes-' + algId);
      }
    }
    loadAlgorithms(category); // Refresh the algorithm list
    updateTimesDisplay();
  }
});

// Event listener for Delete button
$('#delete-alg').on('click', () => {
  const category = $('#category-select').val()?.toString() || '';
  if (checkedAlgorithms.length > 0) {
    if (confirm('Are you sure you want to delete the selected algorithms?')) {
      for (const algorithm of checkedAlgorithms) {
        if (algorithm && category) {
          deleteAlgorithm(category, algorithm.algorithm);
        }
      }
      loadAlgorithms(category); // Refresh the algorithm list
      // make sure delete mode is off
      const deleteModeToggle = $('#delete-mode-toggle');
      deleteModeToggle.prop('checked', false);
      deleteModeToggle.toggle();
      $('#delete-alg').prop('disabled', true);
      $('#delete-times').prop('disabled', true);
      checkedAlgorithms = [];
      checkedAlgorithmsCopy = [];
      // only re-load subsets if there are no more alg-cases (subset has been deleted)
      if ($('#alg-cases').children().length === 0) {
        loadSubsets(category);
      }
      // only re-load categories if there are no more subsets (category has been deleted)
      if ($('#subset-checkboxes-container').children().length === 0) {
        $('#select-all-subsets-toggle').prop('checked', false);
        loadCategories();
      }
      $('#delete-success').text('Algorithms deleted successfully');
      $('#delete-success').show();
      setTimeout(() => {
        $('#delete-success').fadeOut();
      }, 3000); // Disappears after 3 seconds
    }
  }
});

// Event listener for Cancel button
$('#cancel-save').on('click', () => {
  $('#save-container').hide();
  $('#train-alg').trigger('click');
});

// Event listener for Confirm Save button
$('#confirm-save').on('click', () => {
  const category = $('#category-input').val()?.toString().trim() || '';
  const subset = $('#subset-input').val()?.toString().trim() || '';
  const caseName = $('#alg-name-input').val()?.toString().trim() || '';
  const algorithm = expandNotation($('#alg-input').val()?.toString().trim() || '');

  if (category.length > 0 && subset.length > 0 && caseName.length > 0 && algorithm.length > 0) {
    // Save with defaults: algName='Main', isFavorite=false (will be set to true if first algorithm for this case)
    saveAlgorithm(category, subset, caseName, algorithm, 'Main', false);
    $('#save-container').hide();
    $('#category-input').val('');
    $('#subset-input').val('');
    $('#save-error').hide();
    $('#save-success').text('Algorithm saved successfully');
    $('#save-success').show();
    setTimeout(() => {
      $('#save-success').fadeOut();
    }, 3000); // Disappears after 3 seconds
    loadCategories();
    // select the new category
    $('#category-select').val(category).trigger('change');
  } else {
    $('#save-success').hide();
    $('#save-error').text('Please fill in all fields');
    $('#save-error').show();
    setTimeout(() => {
      $('#save-error').fadeOut();
    }, 3000); // Disappears after 3 seconds
  }
});

function openAlgInCubeDB() {
  // Prefer the currently trained algorithm (userAlg), otherwise fall back to the input field
  let alg = '';
  if (userAlg.length > 0) {
    alg = userAlg.join(' ');
  } else {
    const inputVal = $('#alg-input').val()?.toString().trim() || '';
    alg = inputVal;
  }

  if (!alg) {
    alert('No algorithm to show. Please input or select an algorithm first.');
    return;
  }

  // Expand notation (e.g., r moves) and remove parentheses
  const expanded = expandNotation(alg).replace(/[()]/g, '').trim();
  if (!expanded) {
    alert('No algorithm to show. Please input or select an algorithm first.');
    return;
  }

  // Convert to CubeDB format: spaces -> "_", apostrophe -> "-"
  const cubeDBAlg = expanded.replace(/'/g, '-').replace(/\s+/g, '_');
  // Optionally add stage based on the current category
  const rawCategory = $('#category-select').val()?.toString().toLowerCase() || '';
  let stageParam = '';
  if (rawCategory.includes('cmll')) {
    stageParam = '&stage=cmll';
  } else if (rawCategory.includes('coll')) {
    stageParam = '&stage=coll';
  } else if (rawCategory.includes('f2l')) {
    stageParam = '&stage=f2l';
  } else if (rawCategory.includes('pll')) {
    stageParam = '&stage=pll';
  } else if (rawCategory.includes('oll')) {
    stageParam = '&stage=oll';
  }

  const url = `https://www.cubedb.net/?puzzle=3x3&alg=${cubeDBAlg}${stageParam}&type=alg`;
  window.open(url, '_blank');
}

$('#show-alg').on('click', (event) => {
  event.preventDefault();
  openAlgInCubeDB();
});

function getCurrentAlgorithmYoutube(): string | null {
  const category = $('#category-select').val()?.toString() || '';
  if (!category || !currentAlgName) return null;

  const savedAlgorithms = JSON.parse(localStorage.getItem('savedAlgorithms') || '{}');
  const categoryData = savedAlgorithms[category];
  if (!categoryData) return null;

  const caseData = categoryData.find((c: any) => c.case === currentAlgName);
  if (!caseData) return null;

  const currentExpanded = expandNotation(originalUserAlg.join(' ')).replace(/[()]/g, '').trim();

  let algObj = caseData.algorithms.find((alg: any) =>
    expandNotation(alg.algorithm).replace(/[()]/g, '').trim() === currentExpanded
  );

  if (!algObj) {
    algObj = caseData.algorithms.find((alg: any) => alg.isFavorite);
  }

  return algObj?.youtubeUrl || null;
}

function updateShowVideoButtonVisibility() {
  const youtubeUrl = getCurrentAlgorithmYoutube();
  if (youtubeUrl) {
    $('#show-video').removeClass('hidden');
  } else {
    $('#show-video').addClass('hidden');
  }
}

function openAlgVideo() {
  const youtubeUrl = getCurrentAlgorithmYoutube();
  if (!youtubeUrl) {
    alert('No video configured for this algorithm variant.');
    return;
  }

  const embed = extractYouTubeEmbedUrl(youtubeUrl);
  if (!embed) {
    alert('Invalid YouTube URL.');
    return;
  }

  $('#video-iframe').attr('src', embed);
  $('#video-modal').removeClass('hidden');
}

$('#show-video').on('click', (event) => {
  event.preventDefault();
  openAlgVideo();
});

$('#video-modal-close').on('click', () => {
  $('#video-modal').addClass('hidden');
  $('#video-iframe').attr('src', '');
});

$('#video-modal').on('click', (event) => {
  const target = event.target as HTMLElement;
  if (target.id === 'video-modal') {
    $('#video-modal').addClass('hidden');
    $('#video-iframe').attr('src', '');
  }
});

function getScrambleToSolution(alg: string, state: KPattern) {
  let faceCube = patternToFacelets(state);
  var solvedcube = min2phase.solve(faceCube);
  let inverseAlg = Alg.fromString(expandNotation(alg).replace(/[()]/g, '')).invert();
  let finalState = Alg.fromString(solvedcube + ' ' + inverseAlg.toString()).experimentalSimplify({ cancel: true, puzzleLoader: cube3x3x3 });
  let scramble = Alg.fromString(min2phase.solve(patternToFacelets(faceletsToPattern(SOLVED_STATE).applyAlg(finalState)))).invert();
  let result = scramble.experimentalSimplify({ cancel: true, puzzleLoader: cube3x3x3 }).toString().trim();
  return result;
}

$('#scramble-to').on('click', () => {
  (async () => {
    let cubePattern = await twistyTracker.experimentalModel.currentPattern.get();
    let scramble = getScrambleToSolution(userAlg.join(' '), cubePattern);
    if (scramble.length > 0) {
      scrambleMode = true;
      scrambleToAlg = [...userAlg];
      resetAlg();
      $('#alg-scramble').show();
      $('#alg-scramble').text(scramble);
      // draw real cube state
      if (conn) {
        var solution = await experimentalSolve3x3x3IgnoringCenters(cubePattern);
        twistyPlayer.alg = solution.invert();
      }
    } else {
      scrambleMode = false;
      $('#alg-scramble').hide();
      $('#alg-help-info').hide();
    }
  })();
});

// Event listener for Load (Practice) button
$('#load-alg').on('click', () => {
  resetTimerForModeSwitch();
  $('#top-row').show();
  $('#main-column').show();
  $('#app-top').show();
  const categorySelect = $('#category-select');
  if (categorySelect.val() === null || categorySelect.val() === '') {
    loadCategories();
  }
  $('#load-container').show();
  $('#save-container').hide();
  $('#options-container').hide();
  $('#help').hide();
  $('#info').hide();
  $('#alg-stats').hide();
  $('#alg-name-display-container').hide();
  hideAttackLists();
  // Ensure alg-display uses the first checked algorithm when returning to Practice
  if (checkedAlgorithms.length > 0) {
    const nextAlgorithm = refreshCheckedAlgorithmAt(0);
    if (nextAlgorithm) {
      $('#alg-input').val(nextAlgorithm);
    }
  }
  $('#train-alg').trigger('click');
});

// Event listeners for Attack buttons (PLL & OLL)
$('#pll-attack').on('click', () => openAttackScreen('PLL'));
$('#oll-attack').on('click', () => openAttackScreen('OLL'));

// Event listener for Save button
$('#save-alg').on('click', () => {
  $('#top-row').show();
  $('#main-column').show();
  inputMode = true;
  $('#alg-display-container').hide();
  $('#times-display').html('');
  $('#timer').hide();
  $('#alg-stats').hide();
  $('#alg-name-display-container').hide();
  $('#alg-scramble').hide();
  $('#alg-help-info').hide();
  $('#alg-input').show();
  $('#alg-input').get(0)?.focus();
  $('#app-top').show();
  $('#save-success').hide();
  $('#save-error').hide();
  $('#save-container').show();
  populateSaveFormHelpers();
  $('#load-container').hide();
  $('#options-container').hide();
  $('#help').hide();
  $('#info').hide();
  deactivateAttackMode();
  hideAttackLists();
});

function populateSaveFormHelpers() {
  const raw = localStorage.getItem('savedAlgorithms') || '{}';
  let savedAlgorithms: any = {};
  try {
    savedAlgorithms = JSON.parse(raw);
  } catch {
    savedAlgorithms = {};
  }

  const categories = Object.keys(savedAlgorithms).sort();

  const categorySelect = $('#save-existing-categories');
  const subsetSelect = $('#save-existing-subsets');

  categorySelect.empty();
  categorySelect.append('<option value="">Select...</option>');
  categories.forEach((c) => {
    categorySelect.append(`<option value="${c}">${c}</option>`);
  });

  subsetSelect.empty();
  subsetSelect.append('<option value="">Select...</option>');

  categorySelect.off('change').on('change', function () {
    const selectedCategory = $(this).val() as string;
    $('#category-input').val(selectedCategory || '');

    subsetSelect.empty();
    subsetSelect.append('<option value="">Select...</option>');

    if (selectedCategory && savedAlgorithms[selectedCategory]) {
      const subsets = [...new Set(savedAlgorithms[selectedCategory].map((c: any) => c.subset))].sort();
      subsets.forEach((s: any) => {
        subsetSelect.append(`<option value="${s}">${s}</option>`);
      });
    }
  });

  subsetSelect.off('change').on('change', function () {
    const subset = $(this).val() as string;
    if (subset) {
      $('#subset-input').val(subset);
    }
    // reset select so that same value can be chosen again later
    $(this).val('');
  });
}

function resetDrill() {
  // reset the current practice drill
  $('#timer').hide();
  $('#timer').text('');
  $('#times-display').html('');
  $('#alg-display-container').hide();
  $('#alg-display').html('');
  $('#alg-scramble').hide();
  $('#alg-help-info').hide();
  $('#alg-scramble').text('');
  inputMode = true;
  $('#alg-input').val('');
  $('#alg-input').show();
  $('#alg-stats').hide();
  $('#alg-name-display-container').hide();
  deactivateAttackMode();
}

// Event listener for Category select change
$('#category-select').on('change', () => {
  const category = $('#category-select').val()?.toString();
  if (category) {
    loadSubsets(category);
  }
  // uncheck all checkboxes
  checkedAlgorithms = [];
  checkedAlgorithmsCopy = [];
  $('#select-all-subsets-toggle').prop('checked', false);
  // reset cube alg
  twistyPlayer.alg = '';
  // selecting a new category should reset the current practice drill
  resetDrill();
});

// Add event listener for subset checkboxes
$('#subset-checkboxes').on('change', 'input[type="checkbox"]', () => {
  const selectedCategory = $('#category-select').val() as string;
  loadAlgorithms(selectedCategory);
  checkedAlgorithms = [];
  checkedAlgorithmsCopy = [];
  // if select all toggle is checked select all alg-cases, if select learning toggle is checked select learning alg-cases
  const selectAllToggle = $('#select-all-toggle');
  const selectLearningToggle = $('#select-learning-toggle');
  if (selectAllToggle.is(':checked')) {
    $('#alg-cases input[type="checkbox"]').prop('checked', true).trigger('change');
  } else if (selectLearningToggle.is(':checked')) {
    $('#alg-cases input[type="checkbox"]').each(function () {
      const algId = algToId($(this).data('algorithm'));
      if (learnedStatus(algId) === 1) {
        $(this).prop('checked', true).trigger('change');
      } else {
        $(this).prop('checked', false).trigger('change');
      }
    });
  }
});

// Event listener for Export button
$('#export-algs').on('click', () => {
  exportAlgorithms();
});

// Event listener for Import button
$('#import-algs').on('click', () => {
  $('#import-file').trigger('click');
});

// Event listener for file input change
$('#import-file').on('change', (event) => {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (file) {
    importAlgorithms(file);
  }
});

$('#show-options').on('click', () => {
  $('#top-row').hide();
  $('#app-top').hide();
  $('#load-container').hide();
  $('#save-container').hide();
  $('#info').hide();
  $('#help').hide();
  $('#alg-stats').hide();
  $('#left-side-inner').hide();
  hideAttackLists();
  $('#options-container').show();
});

$(function () {
  renameOldKeys();
  loadConfiguration();
});

function renameOldKeys() {
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith('LastFiveTimes-')) {
      const newKey = key.replace('LastFiveTimes-', 'LastTimes-');
      localStorage.setItem(newKey, localStorage.getItem(key) ?? '');
      localStorage.removeItem(key);
    }
  }
}

function loadConfiguration() {
  const visualization = localStorage.getItem('visualization');
  if (visualization) {
    $('#visualization-select').val(visualization).trigger('change');
  }

  const hintFacelets = localStorage.getItem('hintFacelets');
  if (hintFacelets) {
    hintFaceletsToggle.checked = hintFacelets === 'floating';
    twistyPlayer.hintFacelets = hintFacelets === 'floating' ? 'floating' : 'none';
  } else {
    hintFaceletsToggle.checked = false;
    twistyPlayer.hintFacelets = 'none';
  }

  const fullStickering = localStorage.getItem('fullStickering');
  if (fullStickering) {
    fullStickeringToggle.checked = fullStickering === 'true';
    fullStickeringEnabled = fullStickering === 'true';
  } else {
    fullStickeringToggle.checked = false;
    fullStickeringEnabled = false;
  }

  const backview = localStorage.getItem('backview');
  if (backview) {
    $('#backview-select').val(backview).trigger('change');
  }

  const gyroscopeValue = localStorage.getItem('gyroscope');
  if (gyroscopeValue) {
    gyroscopeToggle.checked = gyroscopeValue === 'enabled';
    gyroscopeEnabled = gyroscopeValue === 'enabled';
  } else {
    gyroscopeToggle.checked = true;
    gyroscopeEnabled = true;
  }

  const controlPanel = localStorage.getItem('control-panel');
  if (controlPanel) {
    controlPanelToggle.checked = controlPanel === 'bottom-row';
    twistyPlayer.controlPanel = controlPanel === 'bottom-row' ? 'bottom-row' : 'none';
  } else {
    controlPanelToggle.checked = false;
    twistyPlayer.controlPanel = 'none';
  }

  const flashingIndicatorState = localStorage.getItem('flashingIndicatorEnabled');
  if (flashingIndicatorState) {
    flashingIndicatorToggle.checked = flashingIndicatorState === 'true';
    flashingIndicatorEnabled = flashingIndicatorState === 'true';
  } else {
    flashingIndicatorToggle.checked = true;
    flashingIndicatorEnabled = true;
  }

  const showAlgnameState = localStorage.getItem('showAlgName');
  if (showAlgnameState) {
    showAlgNameToggle.checked = showAlgnameState === 'true';
    showAlgNameEnabled = showAlgnameState === 'true';
  } else {
    showAlgNameToggle.checked = true;
    showAlgNameEnabled = true;
  }

  const alwaysScrambleToState = localStorage.getItem('alwaysScrambleTo');
  if (alwaysScrambleToState) {
    alwaysScrambleTo = alwaysScrambleToState === 'true';
  } else {
    alwaysScrambleTo = false;
  }
  $('#always-scramble-to-toggle').prop('checked', alwaysScrambleTo);
}

// Add event listener for the gyroscope toggle
var gyroscopeEnabled: boolean = true;
const gyroscopeToggle = document.getElementById('gyroscope-toggle') as HTMLInputElement;
gyroscopeToggle.addEventListener('change', () => {
  gyroscopeEnabled = gyroscopeToggle.checked;
  localStorage.setItem('gyroscope', gyroscopeEnabled ? 'enabled' : 'disabled');
  requestAnimationFrame(amimateCubeOrientation);
});

// Add event listener for the control panel toggle
const controlPanelToggle = document.getElementById('control-panel-toggle') as HTMLInputElement;
controlPanelToggle.addEventListener('change', () => {
  localStorage.setItem('control-panel', controlPanelToggle.checked ? 'bottom-row' : 'none');
  twistyPlayer.controlPanel = controlPanelToggle.checked ? 'bottom-row' : 'none';
});

// Add event listener for the hint facelets toggle
const hintFaceletsToggle = document.getElementById('hintFacelets-toggle') as HTMLInputElement;
hintFaceletsToggle.addEventListener('change', () => {
  localStorage.setItem('hintFacelets', hintFaceletsToggle.checked ? 'floating' : 'none');
  twistyPlayer.hintFacelets = hintFaceletsToggle.checked ? 'floating' : 'none';
});

// Add event listener for the full sticker toggle
export var fullStickeringEnabled: boolean = false;
const fullStickeringToggle = document.getElementById('full-stickering-toggle') as HTMLInputElement;
fullStickeringToggle.addEventListener('change', () => {
  fullStickeringEnabled = fullStickeringToggle.checked;
  localStorage.setItem('fullStickering', fullStickeringToggle.checked.toString());
  if (fullStickeringEnabled) {
    twistyPlayer.experimentalStickering = 'full';
  } else {
    let category = $('#category-select').val()?.toString().toLowerCase() || 'pll';
    setStickering(category);
  }
});

var flashingIndicatorEnabled: boolean = true;
const flashingIndicatorToggle = document.getElementById('flashing-indicator-toggle') as HTMLInputElement;
flashingIndicatorToggle.addEventListener('change', () => {
  flashingIndicatorEnabled = flashingIndicatorToggle.checked;
  localStorage.setItem('flashingIndicatorEnabled', flashingIndicatorToggle.checked.toString());
});

var showAlgNameEnabled: boolean = true;
const showAlgNameToggle = document.getElementById('show-alg-name-toggle') as HTMLInputElement;
showAlgNameToggle.addEventListener('change', () => {
  showAlgNameEnabled = showAlgNameToggle.checked;
  localStorage.setItem('showAlgName', showAlgNameToggle.checked.toString());
  updateTimesDisplay(); // Update display immediately when toggled
});

var alwaysScrambleTo: boolean = false;
$('#always-scramble-to-toggle').on('change', () => {
  alwaysScrambleTo = $('#always-scramble-to-toggle').is(':checked');
  localStorage.setItem('alwaysScrambleTo', alwaysScrambleTo.toString());
});

// Add event listeners for the selectors to update twistyPlayer settings
var forceFix: boolean = false;
$('#visualization-select').on('change', () => {
  const visualizationValue = $('#visualization-select').val() || 'PG3D';
  localStorage.setItem('visualization', visualizationValue as string);
  switch (visualizationValue) {
    case '2D':
      twistyPlayer.visualization = '2D';
      break;
    case '3D':
      twistyPlayer.visualization = '3D';
      break;
    case 'PG3D':
      twistyPlayer.visualization = 'PG3D';
      break;
    case 'experimental-2D-LL':
      twistyPlayer.visualization = 'experimental-2D-LL';
      break;
    case 'experimental-2D-LL-face':
      twistyPlayer.visualization = 'experimental-2D-LL-face';
      break;
    default:
      twistyPlayer.visualization = 'PG3D';
  }
  // fix for 3D visualization not animating after visualization change
  if (conn && (visualizationValue as string).includes('3D')) {
    forceFix = true;
    requestAnimationFrame(amimateCubeOrientation);
  } else {
    forceFix = false;
  }
});

$('#backview-select').on('change', () => {
  const backviewValue = $('#backview-select').val();
  localStorage.setItem('backview', backviewValue as string);
  switch (backviewValue) {
    case 'none':
      twistyPlayer.backView = 'none';
      break;
    case 'side-by-side':
      twistyPlayer.backView = 'side-by-side';
      break;
    case 'top-right':
      twistyPlayer.backView = 'top-right';
      break;
    default:
      twistyPlayer.backView = 'none';
  }
});

const darkModeToggle = document.getElementById('dark-mode-toggle') as HTMLInputElement;

// Check for saved user preference
if (localStorage.getItem('theme') === 'dark' || (!('theme' in localStorage) && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
  document.documentElement.classList.add('dark');
  darkModeToggle.checked = true; // Set checkbox to checked if dark mode is active
} else {
  document.documentElement.classList.remove('dark');
  darkModeToggle.checked = false; // Set checkbox to unchecked if dark mode is not active
}

// Add event listener for the dark mode toggle checkbox
darkModeToggle.addEventListener('change', () => {
  document.documentElement.classList.toggle('dark', darkModeToggle.checked);
  if (darkModeToggle.checked) {
    localStorage.setItem('theme', 'dark');
  } else {
    localStorage.setItem('theme', 'light');
  }
  // redraw input alg
  updateAlgDisplay();
});

// Event listener for the select all subsets toggle
$('#select-all-subsets-toggle').on('change', function () {
  const selectAllToggle = $('#select-all-toggle');
  const selectLearningToggle = $('#select-learning-toggle');
  checkedAlgorithms = [];
  checkedAlgorithmsCopy = [];
  const isChecked = $(this).is(':checked');
  if (isChecked) {
    $('#subset-checkboxes-container input[type="checkbox"]').prop('checked', true);
    const selectedCategory = $('#category-select').val() as string;
    loadAlgorithms(selectedCategory);
    // if select all toggle is checked select all alg-cases, if select learning toggle is checked select learning alg-cases
    if (selectAllToggle.is(':checked')) {
      $('#alg-cases input[type="checkbox"]').prop('checked', true).trigger('change');
    } else if (selectLearningToggle.is(':checked')) {
      // check learnedStatus for each algorithm and select the ones that are learned
      $('#alg-cases input[type="checkbox"]').each(function () {
        const algId = algToId($(this).data('algorithm'));
        if (learnedStatus(algId) === 1) {
          $(this).prop('checked', true).trigger('change');
        } else {
          $(this).prop('checked', false).trigger('change');
        }
      });
    }
  } else {
    $('#subset-checkboxes-container input[type="checkbox"]').prop('checked', false);
    loadAlgorithms('');
  }
});

// Add event listener for the select all toggle
const selectAllToggle = document.getElementById('select-all-toggle') as HTMLInputElement;
selectAllToggle.addEventListener('change', () => {
  // when select all toggle is checked, uncheck the select learning toggle
  $('#select-learning-toggle').prop('checked', false);
  checkedAlgorithms = [];
  checkedAlgorithmsCopy = [];
  $('#alg-cases input[type="checkbox"]').prop('checked', selectAllToggle.checked).trigger('change');
});

// Add event listener for the select learning toggle
$('#select-learning-toggle').on('change', function () {
  // when select learning toggle is checked, uncheck the select all toggle
  $('#select-all-toggle').prop('checked', false);
  // when select learning toggle is checked, uncheck all the selected algorithms
  $('#alg-cases input[type="checkbox"]:checked').prop('checked', false);
  const isChecked = $(this).is(':checked');
  const currentCategory = $('#category-select').val() as string;
  const checkedSubsets = $('#subset-checkboxes-container input[type="checkbox"]:checked')
    .map((_, el) => $(el).val())
    .get();

  // Clear current selections
  checkedAlgorithms = [];
  checkedAlgorithmsCopy = [];

  if (isChecked) {
    // Iterate over the current category and checked subsets
    const savedAlgorithms = JSON.parse(localStorage.getItem('savedAlgorithms') || '{}');
    if (savedAlgorithms[currentCategory]) {
      savedAlgorithms[currentCategory].forEach((subset: { subset: string, algorithms: { name: string, algorithm: string }[] }) => {
        if (checkedSubsets.includes(subset.subset)) {
          subset.algorithms.forEach(alg => {
            const algId = algToId(alg.algorithm);
            if (learnedStatus(algId) === 1) {
              // Check the checkbox for this algorithm
              $(`#alg-cases input[data-algorithm="${alg.algorithm}"][data-name="${alg.name}"]`).prop('checked', true).trigger('change');
            }
          });
        }
      });
    }
  } else {
    // Uncheck all checkboxes if the toggle is unchecked
    $('#alg-cases input[type="checkbox"]').prop('checked', false).trigger('change');
  }
});

// Add event listener for the random order toggle
let randomAlgorithms: boolean = false;
const randomOrderToggle = document.getElementById('random-order-toggle') as HTMLInputElement;
randomOrderToggle.addEventListener('change', () => {
  randomAlgorithms = randomOrderToggle.checked;
  if (prioritizeSlowAlgs) {
    prioritizeSlowToggle.checked = false
    prioritizeSlowAlgs = false
  }
});

// Add event listener for the random AUF toggle
let randomizeAUF: boolean = false;
const randomAUFToggle = document.getElementById('random-auf-toggle') as HTMLInputElement;
randomAUFToggle.addEventListener('change', () => {
  randomizeAUF = randomAUFToggle.checked;
});

// Add event listener for the prioritize slow toggle
let prioritizeSlowAlgs: boolean = false;
const prioritizeSlowToggle = document.getElementById('prioritize-slow-toggle') as HTMLInputElement;
prioritizeSlowToggle.addEventListener('change', () => {
  prioritizeSlowAlgs = prioritizeSlowToggle.checked;
  if (randomAlgorithms) {
    randomOrderToggle.checked = false
    randomAlgorithms = false
  }
});

// Add event listener for the prioritize failed toggle
let prioritizeFailedAlgs: boolean = false;
const prioritizeFailedToggle = document.getElementById('prioritize-failed-toggle') as HTMLInputElement;
prioritizeFailedToggle.addEventListener('change', () => {
  prioritizeFailedAlgs = prioritizeFailedToggle.checked;
});

$('#toggle-move-mask').on('click', (event) => {
  event.preventDefault();
  toggleMoveMask();
});

let isMoveMasked: boolean = false;
function toggleMoveMask() {
  isMoveMasked = !isMoveMasked; // Toggle the state
  $('.move').each(function () {
    $(this).css('-webkit-text-security', isMoveMasked ? 'disc' : 'none');
  });
  // change color of toggle-move-mask button
  $('#toggle-move-mask').toggleClass('bg-orange-500 hover:bg-orange-700', isMoveMasked).toggleClass('bg-blue-500 hover:bg-blue-700', !isMoveMasked);
  $('#toggle-move-mask').html(isMoveMasked ? '<svg fill="currentColor" class="h-6 w-6 inline-block" viewBox="-5.5 0 32 32" version="1.1" xmlns="http://www.w3.org/2000/svg"><path d="M10.32 22.32c-5.6 0-9.92-5.56-10.12-5.8-0.24-0.32-0.24-0.72 0-1.040 0.2-0.24 4.52-5.8 10.12-5.8s9.92 5.56 10.12 5.8c0.24 0.32 0.24 0.72 0 1.040-0.2 0.24-4.56 5.8-10.12 5.8zM1.96 16c1.16 1.32 4.52 4.64 8.36 4.64s7.2-3.32 8.36-4.64c-1.16-1.32-4.52-4.64-8.36-4.64s-7.2 3.32-8.36 4.64zM10.32 20c-2.2 0-4-1.8-4-4s1.8-4 4-4 4 1.8 4 4-1.84 4-4 4zM10.32 13.68c-1.28 0-2.32 1.040-2.32 2.32s1.040 2.32 2.32 2.32 2.32-1.040 2.32-2.32-1.040-2.32-2.32-2.32z"></path></svg> Unmask alg' : '<svg fill="currentColor" class="h-6 w-6 inline-block" viewBox="-5.5 0 32 32" version="1.1" xmlns="http://www.w3.org/2000/svg"><path d="M20.44 15.48c-0.12-0.16-2.28-2.92-5.48-4.56l0.92-3c0.12-0.44-0.12-0.92-0.56-1.040s-0.92 0.12-1.040 0.56l-0.88 2.8c-0.96-0.32-2-0.56-3.080-0.56-5.6 0-9.92 5.56-10.12 5.8-0.24 0.32-0.24 0.72 0 1.040 0.16 0.24 4.2 5.36 9.48 5.76l-0.56 1.8c-0.12 0.44 0.12 0.92 0.56 1.040 0.080 0.040 0.16 0.040 0.24 0.040 0.36 0 0.68-0.24 0.8-0.6l0.72-2.36c5-0.68 8.8-5.48 9-5.72 0.24-0.28 0.24-0.68 0-1zM1.96 16c1.16-1.32 4.52-4.64 8.36-4.64 0.88 0 1.76 0.2 2.6 0.48l-0.28 0.88c-0.68-0.48-1.48-0.72-2.32-0.72-2.2 0-4 1.8-4 4s1.8 4 4 4c0.040 0 0.040 0 0.080 0l-0.2 0.64c-3.8-0.080-7.080-3.36-8.24-4.64zM10.88 18.24c-0.2 0.040-0.4 0.080-0.6 0.080-1.28 0-2.32-1.040-2.32-2.32s1.040-2.32 2.32-2.32c0.68 0 1.32 0.32 1.76 0.8l-1.16 3.76zM12 20.44l2.4-7.88c1.96 1.080 3.52 2.64 4.24 3.44-0.96 1.12-3.52 3.68-6.64 4.44z"></path></svg> Mask alg');
}

const menuToggle = document.getElementById('menu-toggle');
const menuItems = document.getElementById('menu-items');
if (menuToggle && menuItems) {
  menuToggle.addEventListener('click', () => {
    menuItems.classList.toggle('hidden');
  });

  document.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    if (!menuToggle.contains(target) && !menuItems.contains(target)) {
      menuItems.classList.add('hidden');
    }
  });
}

// Add event listeners to menu items
const menuButtons = document.querySelectorAll('#menu-items button');
menuButtons.forEach(item => {
  item.addEventListener('click', () => {
    // Remove 'selected' class from all menu items
    menuButtons.forEach(i => i.classList.remove('selected'));
    // Add 'selected' class to the clicked item
    item.classList.add('selected');
  });
});

const categorySelect = $('#category-select');
if (categorySelect.val() === null || categorySelect.val() === '') {
  loadCategories();
}

// functions to activate timer when using a dumb cube
function activateTimer() {
  if (timerState == "STOPPED" || timerState == "IDLE" || timerState == "READY") {
    showFlashingIndicator('gray', 200);
    setTimerState("RUNNING");
  } else {
    setTimerState("STOPPED");
  }
}

let isKeyboardTimerActive: boolean = false;

$(document).on('keydown', (event) => {
  if (!conn && !inputMode && event.which === 32) {
    event.preventDefault();
    if (timerState == "STOPPED" || timerState == "IDLE") {
      setTimerValue(0);
      setTimerState("READY");
    } else if (timerState == "RUNNING") {
      setTimerState("STOPPED");
    } else if (timerState == "READY" && !isKeyboardTimerActive) {
      setTimerValue(0);
    }
  }
});

$(document).on('keyup', (event) => {
  if (!conn && !inputMode && event.which === 32) {
    event.preventDefault();
    if (timerState == "READY" && !isKeyboardTimerActive) {
      activateTimer();
      isKeyboardTimerActive = true;
    } else {
      isKeyboardTimerActive = false;
    }
  }
});

let isScrolling = false;

$(document).on('touchstart', function () {
  isScrolling = false;
});

$(document).on('touchmove', function () {
  isScrolling = true;
});

$("#touch-timer").on('touchend', () => {
  if (!conn && !inputMode && !isScrolling) {
    activateTimer();
  }
});

$("#times-display").on('touchend', () => {
  if (!conn && !inputMode && !isScrolling) {
    activateTimer();
  }
});

$("#cube").on('touchend', () => {
  if (!conn && !inputMode && !isScrolling) {
    activateTimer();
  }
});

// event listener for the dumbcube toggle
$('#dumbcube-toggle').on('click', () => {
  $('#help-content-smartcube').toggleClass('hidden');
  $('#help-content-dumbcube').toggleClass('hidden');
  if ($('#help-content-smartcube').hasClass('hidden')) {
    $('#help-title').text('DUMBCUBE HELP');
    $('#dumbcube-toggle').html('🛜 USING a smart cube? <a href="#" class="text-blue-500 hover:underline">CLICK HERE</a>');
  } else {
    $('#help-title').text('SMARTCUBE HELP');
    $('#dumbcube-toggle').html('🛜 NOT using a smart cube? <a href="#" class="text-blue-500 hover:underline">CLICK HERE</a>');
  }
});