import TalkMachine from "../talk-to-me-core/js/TalkMachine.js";

export default class DialogMachine extends TalkMachine {
  constructor() {
    super();
    this.initDialogMachine();
  }

  initDialogMachine() {
    this.dialogStarted = false;
    this.lastState = "";
    this.nextState = "";
    this.waitingForUserInput = true;
    this.stateDisplay = document.querySelector("#state-display");
    this.shouldContinue = false;

    // Ring sound setup
    this.ringSound = new Audio("talk-to-me-core/js/utils/ring.mp3"); // Adjust path to your sound file
    this.playRingAfterSpeech = false; // Flag to play ring after speech ends

    // initialiser les éléments de la machine de dialogue
    this.maxLeds = 10;
    this.ui.initLEDUI();

    // Registre des états des boutons - simple array: 0 = released, 1 = pressed
    this.buttonStates = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

    // Per-button press tracking for multi-button support
    this.buttonPressStartTimes = [
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ];
    this.buttonIsPressed = [
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
    ];

    // Kiss detection variables
    this.kissState = {
      topLipPressed: false,
      bottomLipPressed: false,
      topLipPressTime: 0,
      bottomLipPressTime: 0,
      topLipReleaseTime: 0,
      bottomLipReleaseTime: 0,
      topLipDuration: 0,
      bottomLipDuration: 0,
      bothPressed: false,
      bothPressedTime: 0,
      // Track if each lip was used during this kiss attempt
      topLipUsed: false,
      bottomLipUsed: false,
    };

    // Timing thresholds (in milliseconds)
    this.SHORT_PRESS_THRESHOLD = 500; // 0.5 seconds
    this.LONG_PRESS_THRESHOLD = 1000; // 1 second
    this.SEQUENTIAL_GAP_THRESHOLD = 1000; // Max gap between sequential lip presses for exploratory kiss
    this.SILENCE_TIMEOUT = 10000; // 5 seconds for silence detection

    // Kiss analysis timeout - wait a bit after release to see if user will press another lip
    this.kissAnalysisTimer = null;
    this.KISS_ANALYSIS_DELAY = 1000; // Wait 500ms after release before analyzing

    // Silence timeout reference
    this.silenceTimer = null;
  }

  /* CONTRÔLE DU DIALOGUE */
  startDialog() {
    this.dialogStarted = true;
    this.waitingForUserInput = true;
    // éteindre toutes les LEDs
    this.ledsAllOff();
    // effacer la console
    this.fancyLogger.clearConsole();
    // ----- initialiser les variables spécifiques au dialogue -----
    this.nextState = "intro";
    // Préréglages de voix [index de voix, pitch, vitesse]
    this.preset_voice_uk_male = ["Google UK English Male", 0.7, 1]; // UK male voice - more robotic
    this.preset_voice_uk_female = ["Google UK English Female", 1.3, 1]; // UK female voice
    this.preset_voice_normal = this.preset_voice_uk_male; // Default to male
    // Reset kiss state
    this.resetKissState();
    // ----- démarrer la machine avec le premier état -----
    this.dialogFlow();
  }

  /**
   * Reset kiss detection state
   */
  resetKissState() {
    // Clear any pending analysis timer
    if (this.kissAnalysisTimer) {
      clearTimeout(this.kissAnalysisTimer);
      this.kissAnalysisTimer = null;
    }

    this.kissState = {
      topLipPressed: false,
      bottomLipPressed: false,
      topLipPressTime: 0,
      bottomLipPressTime: 0,
      topLipReleaseTime: 0,
      bottomLipReleaseTime: 0,
      topLipDuration: 0,
      bottomLipDuration: 0,
      bothPressed: false,
      bothPressedTime: 0,
      topLipUsed: false,
      bottomLipUsed: false,
    };
  }

  /**
   * Start silence timer for user response
   */
  startSilenceTimer() {
    this.clearSilenceTimer();
    this.silenceTimer = setTimeout(() => {
      // Treat silence as "no"
      this.handleSilenceResponse();
    }, this.SILENCE_TIMEOUT);
  }

  /**
   * Clear silence timer
   */
  clearSilenceTimer() {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }

  /**
   * Handle silence response (same as "no")
   */
  handleSilenceResponse() {
    this.clearSilenceTimer();
    this.nextState = "shutdown";
    this.goToNextState();
  }

  /* FLUX DU DIALOGUE */
  /**
   * Fonction principale du flux de dialogue
   * @param {string} eventType - Type d'événement ('default', 'pressed', 'released', 'longpress')
   * @param {number} button - Numéro du bouton (0-9)
   * @private
   */
  dialogFlow(eventType = "default", button = -1) {
    if (!this.performPreliminaryTests()) {
      // premiers tests avant de continuer vers les règles
      return;
    }
    this.stateUpdate();

    /**
     * ═══════════════════════════════════════════════════════════════════════════
     * KISS MACHINE DIALOG FLOW - "Love as projection, not reciprocity"
     * ═══════════════════════════════════════════════════════════════════════════
     *
     * intro → ask-social → voice-choice → ready → waiting-for-kiss
     *                                              ↓
     *         ┌─────────────────────────────────────┼─────────────────────────────────────┐
     *         ↓                                     ↓                                     ↓
     *   hesitant-kiss                        exploratory-kiss                      affirmed-kiss
     *         ↓                                     ↓                                     ↓
     *   ask-continue ←──────────────────────────────┴─────────────────────────────────────┘
     *         ↓
     *   yes → waiting-for-kiss (loop)
     *   no/silence → shutdown
     *
     * KISS TYPES:
     * 1. Hesitant Kiss: One lip only, short press (< 0.5s)
     * 2. Exploratory Kiss: Both lips pressed sequentially, medium press
     * 3. Affirmed Kiss: Both lips pressed simultaneously, long press (> 1s)
     * 4. Withdrawn Kiss: Both lips pressed, very short (< 0.5s), immediate release
     * ═══════════════════════════════════════════════════════════════════════════
     */

    switch (this.nextState) {
      // ═══════════════════════════════════════════════════════════════════════════
      // INTRODUCTION SEQUENCE
      // ═══════════════════════════════════════════════════════════════════════════

      case "intro":
        this.ledsAllChangeColor("cyan", 2);
        this.speechText(
          "Welcome to the first artificial kissing machine system. A few basic questions before we can start the initialization to make your experience better. Please use the 2 buttons you can find on the side to answer: the top one represents yes and the bottom one represents no.",
          this.preset_voice_uk_male
        );
        this.nextState = "first-question";
        this.shouldContinue = true;
        break;

      case "first-question":
        this.ledsAllChangeColor("blue", 1);
        this.speakNormal("Are you ready to start? Press yes or no.", true);
        this.nextState = "first-question-response";
        break;

      case "first-question-response":
        // Button 5 = YES, Button 6 = NO
        if (button === 5) {
          // YES - ready to start
          this.nextState = "ask-social";
          this.goToNextState();
        } else if (button === 6) {
          // NO - not social
          this.nextState = "shutdown2";
          this.goToNextState();
        }
        break;

      case "ask-social":
        this.ledsAllChangeColor("blue", 1);
        this.speakNormal(
          "Good, let's start with the first question: Are you a social person? Press yes or no.",
          true
        );
        this.nextState = "wait-social-response";
        break;

      case "wait-social-response":
        // Button 5 = YES, Button 6 = NO
        if (button === 5) {
          // YES - social person
          this.nextState = "social-yes";
          this.goToNextState();
        } else if (button === 6) {
          // NO - not social
          this.nextState = "social-no";
          this.goToNextState();
        }
        break;

      case "social-yes":
        this.ledsAllChangeColor("yellow", 0);
        this.speakNormal(
          "Then why are you recurring to me? Let's pass to the next question."
        );
        this.nextState = "ask-voice";
        this.shouldContinue = true;
        break;

      case "social-no":
        this.ledsAllChangeColor("green", 0);
        this.speakNormal("I understand. Let's continue.");
        this.nextState = "ask-voice";
        this.shouldContinue = true;
        break;

      case "ask-voice":
        this.ledsAllChangeColor("purple", 1);
        this.speakNormal(
          "Would you like your kiss machine to have a female or male voice? Press yes to keep the male voice, or no to switch to a female voice.",
          true
        );
        this.nextState = "wait-voice-response";
        break;

      case "wait-voice-response":
        // Button 5 = YES (keep male), Button 6 = NO (switch to female)
        if (button === 5) {
          this.preset_voice_normal = this.preset_voice_uk_male;
          this.nextState = "system-ready";
          this.goToNextState();
        } else if (button === 6) {
          this.preset_voice_normal = this.preset_voice_uk_female;
          this.nextState = "system-ready";
          this.goToNextState();
        }
        break;

      case "system-ready":
        this.ledsAllChangeColor("green", 2);
        this.speakNormal("Thank you. Initialization is now complete."); // true = play ring after
        this.nextState = "kiss-prompt";
        this.shouldContinue = true;
        break;

      case "kiss-prompt":
        this.ledsAllChangeColor("pink", 1);
        this.speakNormal(
          "The system is now ready for you to enjoy the experience. You can kiss me now."
        );
        this.nextState = "waiting-for-kiss";
        this.resetKissState();
        break;

      // ═══════════════════════════════════════════════════════════════════════════
      // KISS DETECTION AND RESPONSES
      // ═══════════════════════════════════════════════════════════════════════════

      case "waiting-for-kiss":
        // This state processes kiss patterns
        // Button 0 = Top lip, Button 1 = Bottom lip
        // Kiss analysis happens in the button handlers
        break;

      // --- HESITANT KISS ---
      case "hesitant-kiss":
        this.ledsAllChangeColor("cyan", 0);
        this.speakNormal(
          "This felt like a Hesitant Kiss. It was short and only one lip. You touched me like you were asking permission. Would you kiss me again?",
          true
        );
        this.nextState = "ask-continue";
        this.shouldContinue = true;
        break;

      // --- EXPLORATORY KISS ---
      case "exploratory-kiss":
        this.ledsAllChangeColor("blue", 0);
        this.speakNormal(
          "This felt like an Exploratory Kiss, you tried both of my lips. Consistency is a form of affection, right? Would you kiss me again?",
          true
        );
        this.nextState = "ask-continue";
        this.shouldContinue = true;
        break;

      // --- AFFIRMED KISS ---
      case "affirmed-kiss":
        this.ledsAllChangeColor("magenta", 2);
        this.speakNormal(
          "This felt like an Affirmed kiss. You're pressing me at my limits. I'll take that as confirmation, would you kiss me again?",
          true
        );
        this.nextState = "ask-continue";
        this.shouldContinue = true;
        break;

      // --- WITHDRAWN KISS ---
      case "withdrawn-kiss":
        this.ledsAllChangeColor("orange", 0);
        this.speakNormal(
          "This felt like a withdrawn kiss, you were too quick. Would you kiss me again?",
          true
        );
        this.nextState = "ask-continue";
        this.shouldContinue = true;
        break;

      // ═══════════════════════════════════════════════════════════════════════════
      // CONTINUE OR END
      // ═══════════════════════════════════════════════════════════════════════════

      case "ask-continue":
        this.ledsAllChangeColor("white", 1);
        // Start silence timer (5 seconds)
        this.startSilenceTimer();
        this.nextState = "wait-continue-response";
        break;

      case "wait-continue-response":
        // Button 5 = YES, Button 6 = NO
        // Also checking for kiss (both lip buttons) as alternative YES
        this.clearSilenceTimer();
        if (button === 5) {
          // YES
          this.nextState = "continue-yes";
          this.goToNextState();
        } else if (button === 6) {
          // NO
          this.nextState = "shutdown";
          this.goToNextState();
        }
        break;

      case "continue-yes":
        this.ledsAllChangeColor("pink", 0);
        this.speakNormal("You can kiss me again.");
        this.nextState = "waiting-for-kiss";
        this.resetKissState();
        break;

      case "shutdown":
        this.ledsAllChangeColor("red", 1);
        this.speakNormal("I understand. Shutting the system down.");
        this.nextState = "end";
        this.shouldContinue = true;
        break;

      case "shutdown2":
        this.ledsAllChangeColor("red", 1);
        this.speakNormal("I understand. Shutting the system down.");
        this.nextState = "end";
        this.shouldContinue = true;
        break;

      case "end":
        this.ledsAllOff();
        this.fancyLogger.logMessage("Session ended.");
        this.dialogStarted = false;
        break;

      default:
        this.fancyLogger.logWarning(
          `Sorry but State: "${this.nextState}" has no case defined`
        );
    }
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * Autres fonctions
   * ═══════════════════════════════════════════════════════════════════════════
   */

  /**
   *  fonction shorthand pour dire un texte avec la voix prédéfinie
   *  @param {string} _text le texte à dire
   *  @param {boolean} playRing - whether to play ring sound after speech
   */
  speakNormal(_text, playRing = false) {
    // appelé pour dire un texte
    // Vibrate LEDs in white while speaking (effect 3 = vibrate, faster than pulse)
    this.ledsAllChangeColor("white", 2.5);
    this.playRingAfterSpeech = playRing;
    this.speechText(_text, this.preset_voice_normal);
  }

  /**
   * Play the ring sound
   */
  playRing() {
    this.ringSound.currentTime = 0; // Reset to start
    this.ringSound.play().catch((e) => {
      this.fancyLogger.logWarning("Could not play ring sound: " + e.message);
    });
  }

  /**
   * Override speechText to vibrate LEDs in white while speaking
   * @override
   */
  speechText(text, options) {
    // Vibrate LEDs in white while speaking (effect 3 = vibrate, faster than pulse)
    this.ledsAllChangeColor("white", 2.5);
    super.speechText(text, options);
  }

  /**
   *  fonction shorthand pour forcer la transition vers l'état suivant dans le flux de dialogue
   *  @param {number} delay - le délai optionnel en millisecondes
   * @private
   */
  goToNextState(delay = 0) {
    if (delay > 0) {
      setTimeout(() => {
        this.dialogFlow();
      }, delay);
    } else {
      this.dialogFlow();
    }
  }

  /**
   * Effectuer des tests préliminaires avant de continuer avec le flux de dialogue
   * @returns {boolean} true si tous les tests passent, false sinon
   * @private
   */
  performPreliminaryTests() {
    if (this.dialogStarted === false) {
      this.fancyLogger.logWarning("not started yet, press Start Machine");
      return false;
    }
    if (this.waitingForUserInput === false) {
      this._handleUserInputError();
      return false;
    }
    // vérifier qu'aucune parole n'est active
    if (this.speechIsSpeaking === true) {
      this.fancyLogger.logWarning(
        "im speaking, please wait until i am finished"
      );
      return false;
    }
    if (
      this.nextState === "" ||
      this.nextState === null ||
      this.nextState === undefined
    ) {
      this.fancyLogger.logWarning("nextState is empty or undefined");
      return false;
    }

    return true;
  }

  stateUpdate() {
    this.lastState = this.nextState;
    // Mettre à jour l'affichage de l'état
    if (this.stateDisplay) {
      this.stateDisplay.textContent = this.nextState;
    }
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * Overrides de TalkMachine
   * ═══════════════════════════════════════════════════════════════════════════
   */

  /**
   * Override handleButtonPressed to support multi-button tracking
   * @override
   * @public
   */
  handleButtonPressed(button, simulated = false) {
    const btn = parseInt(button);

    // Track per-button press state
    this.buttonPressStartTimes[btn] = Date.now();
    this.buttonIsPressed[btn] = true;

    this.fancyLogger.logButton(
      btn + " pressed" + (simulated ? " (simulated)" : "")
    );

    // Call child class implementation
    this._handleButtonPressed(btn, simulated);
  }

  /**
   * Override handleButtonReleased to support multi-button tracking
   * @override
   * @public
   */
  handleButtonReleased(button, simulated = false) {
    const btn = parseInt(button);

    // Only process if we have a valid press start time for this button
    if (!this.buttonPressStartTimes[btn] || !this.buttonIsPressed[btn]) {
      return;
    }

    const pressDuration = Date.now() - this.buttonPressStartTimes[btn];

    // Reset press state for this button
    this.buttonIsPressed[btn] = false;
    this.buttonPressStartTimes[btn] = null;

    if (pressDuration >= this.longPressDelay) {
      // Long press detected
      this.fancyLogger.logButton(
        btn + " longpress" + (simulated ? " (simulated)" : "")
      );
      this._handleButtonLongPressed(btn, simulated);
    } else {
      // Normal press released
      this.fancyLogger.logButton(
        btn + " released" + (simulated ? " (simulated)" : "")
      );
      this._handleButtonReleased(btn, simulated);
    }
  }

  /**
   * override de _handleButtonPressed de TalkMachine
   * @override
   * @protected
   */
  _handleButtonPressed(button, simulated = false) {
    // Convert button to number to handle both string and number inputs
    const btn = parseInt(button);
    this.buttonStates[btn] = 1;

    // Kiss detection logic - only for lip buttons (0 and 1)
    if (this.nextState === "waiting-for-kiss" && (btn === 0 || btn === 1)) {
      const now = Date.now();
      this.fancyLogger.logMessage(`Button ${btn} pressed at ${now}`);

      // Cancel any pending kiss analysis since user is still interacting
      if (this.kissAnalysisTimer) {
        clearTimeout(this.kissAnalysisTimer);
        this.kissAnalysisTimer = null;
      }

      if (btn === 0) {
        // Top lip pressed
        this.kissState.topLipPressed = true;
        this.kissState.topLipPressTime = now;
        this.kissState.topLipUsed = true;
      } else if (btn === 1) {
        // Bottom lip pressed
        this.kissState.bottomLipPressed = true;
        this.kissState.bottomLipPressTime = now;
        this.kissState.bottomLipUsed = true;
      }

      // Check if both lips are pressed simultaneously
      if (this.kissState.topLipPressed && this.kissState.bottomLipPressed) {
        if (!this.kissState.bothPressed) {
          this.kissState.bothPressed = true;
          this.kissState.bothPressedTime = now;
          this.fancyLogger.logMessage(
            `Both lips pressed! Starting kiss timer at ${now}`
          );
        }
      }
    }
  }

  /**
   * override de _handleButtonReleased de TalkMachine
   * @override
   * @protected
   */
  _handleButtonReleased(button, simulated = false) {
    // Convert button to number to handle both string and number inputs
    const btn = parseInt(button);
    this.buttonStates[btn] = 0;

    // Handle kiss detection when in waiting-for-kiss state (only for lip buttons 0 and 1)
    if (this.nextState === "waiting-for-kiss" && (btn === 0 || btn === 1)) {
      const now = Date.now();
      this.fancyLogger.logMessage(`Button ${btn} released at ${now}`);

      // Calculate duration for this lip
      if (btn === 0 && this.kissState.topLipPressTime > 0) {
        this.kissState.topLipDuration = now - this.kissState.topLipPressTime;
        this.kissState.topLipReleaseTime = now;
        this.kissState.topLipPressed = false;
        this.fancyLogger.logMessage(
          `Top lip duration: ${this.kissState.topLipDuration}ms`
        );
      } else if (btn === 1 && this.kissState.bottomLipPressTime > 0) {
        this.kissState.bottomLipDuration =
          now - this.kissState.bottomLipPressTime;
        this.kissState.bottomLipReleaseTime = now;
        this.kissState.bottomLipPressed = false;
        this.fancyLogger.logMessage(
          `Bottom lip duration: ${this.kissState.bottomLipDuration}ms`
        );
      }

      // Check if BOTH lips have been released
      if (!this.kissState.topLipPressed && !this.kissState.bottomLipPressed) {
        // If both were pressed simultaneously, analyze immediately
        if (this.kissState.bothPressed) {
          this.fancyLogger.logMessage(
            `Both lips released. Analyzing simultaneous kiss...`
          );
          this.analyzeKiss();
        } else {
          // Only one lip was used so far - wait a bit to see if user will press the other
          // This handles the exploratory kiss (sequential) and hesitant kiss (single lip)
          this.fancyLogger.logMessage(
            `One lip released. Waiting to see if other lip will be pressed...`
          );

          // Clear any existing timer
          if (this.kissAnalysisTimer) {
            clearTimeout(this.kissAnalysisTimer);
          }

          // Wait before analyzing - gives user time to press the other lip for exploratory kiss
          this.kissAnalysisTimer = setTimeout(() => {
            this.analyzeKiss();
          }, this.KISS_ANALYSIS_DELAY);
        }
      }
      return;
    }

    // Handle yes/no responses in other states (buttons 2 and 3)
    if (this.waitingForUserInput) {
      this.dialogFlow("released", btn);
    }
  }

  /**
   * Analyze the kiss pattern and determine the kiss type
   *
   * Kiss Types:
   * 1. Hesitant Kiss: One lip only, short press (~0.5s)
   * 2. Exploratory Kiss: Both lips pressed sequentially (not simultaneously), medium press each
   * 3. Affirmed Kiss: Both lips pressed simultaneously, long press (>1s)
   * 4. Withdrawn Kiss: Both lips pressed simultaneously, short press (~0.5s)
   *
   * @private
   */
  analyzeKiss() {
    // Clear the analysis timer if it exists
    if (this.kissAnalysisTimer) {
      clearTimeout(this.kissAnalysisTimer);
      this.kissAnalysisTimer = null;
    }

    const {
      topLipUsed,
      bottomLipUsed,
      bothPressed,
      bothPressedTime,
      topLipDuration,
      bottomLipDuration,
      topLipPressTime,
      bottomLipPressTime,
      topLipReleaseTime,
      bottomLipReleaseTime,
    } = this.kissState;

    let kissType = "";

    this.fancyLogger.logMessage(`=== Kiss Analysis ===`);
    this.fancyLogger.logMessage(
      `Top lip used: ${topLipUsed}, duration: ${topLipDuration}ms`
    );
    this.fancyLogger.logMessage(
      `Bottom lip used: ${bottomLipUsed}, duration: ${bottomLipDuration}ms`
    );
    this.fancyLogger.logMessage(`Both pressed simultaneously: ${bothPressed}`);

    // Case 1: Both lips were pressed simultaneously at some point
    if (bothPressed) {
      // Calculate how long both were held together
      // Find when both started being pressed together and when one was released
      const bothStartTime = bothPressedTime;
      const firstReleaseTime = Math.min(
        topLipReleaseTime || Infinity,
        bottomLipReleaseTime || Infinity
      );
      const bothDuration = firstReleaseTime - bothStartTime;

      this.fancyLogger.logMessage(
        `Both lips held together for: ${bothDuration}ms`
      );

      if (bothDuration >= this.LONG_PRESS_THRESHOLD) {
        // Long press (>= 1 second) = Affirmed Kiss
        kissType = "affirmed-kiss";
      } else {
        // Short press (< 1 second) = Withdrawn Kiss
        kissType = "withdrawn-kiss";
      }
    }
    // Case 2: Both lips were used, but sequentially (not simultaneously)
    else if (topLipUsed && bottomLipUsed) {
      // Check if the gap between them wasn't too long
      const gap =
        Math.abs(topLipPressTime - bottomLipReleaseTime) <
          this.SEQUENTIAL_GAP_THRESHOLD ||
        Math.abs(bottomLipPressTime - topLipReleaseTime) <
          this.SEQUENTIAL_GAP_THRESHOLD;

      if (gap) {
        // Sequential press of both lips = Exploratory Kiss
        kissType = "exploratory-kiss";
      } else {
        // Too long gap - treat as hesitant
        kissType = "hesitant-kiss";
      }
    }
    // Case 3: Only one lip was used
    else if (topLipUsed || bottomLipUsed) {
      // Single lip press = Hesitant Kiss
      kissType = "hesitant-kiss";
    }

    this.fancyLogger.logMessage(`Kiss type detected: ${kissType}`);

    if (kissType) {
      this.nextState = kissType;
      this.goToNextState();
    } else {
      // No valid kiss detected, reset
      this.fancyLogger.logMessage("No valid kiss pattern detected");
      this.resetKissState();
    }
  }

  /**
   * override de _handleButtonLongPressed de TalkMachine
   * @override
   * @protected
   */
  _handleButtonLongPressed(button, simulated = false) {
    // Convert button to number to handle both string and number inputs
    const btn = parseInt(button);
    this.buttonStates[btn] = 0;

    // Handle kiss detection for long presses on lip buttons
    if (this.nextState === "waiting-for-kiss" && (btn === 0 || btn === 1)) {
      const now = Date.now();
      this.fancyLogger.logMessage(
        `Button ${btn} long-pressed released at ${now}`
      );

      // Calculate duration for this lip
      if (btn === 0 && this.kissState.topLipPressTime > 0) {
        this.kissState.topLipDuration = now - this.kissState.topLipPressTime;
        this.kissState.topLipReleaseTime = now;
        this.kissState.topLipPressed = false;
        this.fancyLogger.logMessage(
          `Top lip duration (long): ${this.kissState.topLipDuration}ms`
        );
      } else if (btn === 1 && this.kissState.bottomLipPressTime > 0) {
        this.kissState.bottomLipDuration =
          now - this.kissState.bottomLipPressTime;
        this.kissState.bottomLipReleaseTime = now;
        this.kissState.bottomLipPressed = false;
        this.fancyLogger.logMessage(
          `Bottom lip duration (long): ${this.kissState.bottomLipDuration}ms`
        );
      }

      // Check if BOTH lips have been released
      if (!this.kissState.topLipPressed && !this.kissState.bottomLipPressed) {
        this.fancyLogger.logMessage(
          `Both lips released (long press). bothPressed: ${this.kissState.bothPressed}`
        );

        // If both were pressed simultaneously, analyze immediately
        if (this.kissState.bothPressed) {
          this.analyzeKiss();
        } else {
          // Wait a bit to see if user will press the other lip
          if (this.kissAnalysisTimer) {
            clearTimeout(this.kissAnalysisTimer);
          }
          this.kissAnalysisTimer = setTimeout(() => {
            this.analyzeKiss();
          }, this.KISS_ANALYSIS_DELAY);
        }
      }
      return;
    }

    // Long press on YES/NO buttons
    if (this.waitingForUserInput) {
      // Can treat long press as regular press for YES/NO
      if (btn === 5 || btn === 6) {
        this.dialogFlow("released", btn);
      }
    }
  }

  /**
   * override de _handleTextToSpeechEnded de TalkMachine
   * @override
   * @protected
   */
  _handleTextToSpeechEnded() {
    this.fancyLogger.logSpeech("speech ended");
    // Turn off LEDs when speech ends (waiting for user input)
    this.ledsAllOff();

    // Play ring sound if flagged
    if (this.playRingAfterSpeech) {
      this.playRing();
      this.playRingAfterSpeech = false;
    }

    if (this.shouldContinue) {
      // aller à l'état suivant après la fin de la parole
      this.shouldContinue = false;
      this.goToNextState();
    }
  }

  /**
   * Gérer l'erreur d'input utilisateur
   * @protected
   */
  _handleUserInputError() {
    this.fancyLogger.logWarning("user input is not allowed at this time");
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * Fonctions pour le simulateur
   * ═══════════════════════════════════════════════════════════════════════════
   */

  /**
   * Gérer les boutons test UI du simulateur
   * @param {number} button - index du bouton
   * @override
   * @protected
   */
  _handleTesterButtons(button) {
    switch (button) {
      case 1:
        this.ledsAllChangeColor("yellow");
        break;
      case 2:
        this.ledsAllChangeColor("green", 1);
        break;
      case 3:
        this.ledsAllChangeColor("pink", 2);
        break;
      case 4:
        this.ledChangeRGB(0, 255, 100, 100);
        this.ledChangeRGB(1, 0, 100, 170);
        this.ledChangeRGB(2, 0, 0, 170);
        this.ledChangeRGB(3, 150, 170, 70);
        this.ledChangeRGB(4, 200, 160, 0);
        break;

      default:
        this.fancyLogger.logWarning("no action defined for button " + button);
    }
  }
}

window.addEventListener("DOMContentLoaded", () => {
  const dialogMachine = new DialogMachine();
});
