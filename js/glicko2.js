export function glicko2RatingUpdate(rating, rd, sigma, tau, oppRating, oppRd, score, epsilon = 1e-6) {
    const PI2 = Math.PI ** 2;
    const SCALE = 173.7178;

    // Step 1: Convert rating and rd to the Glicko-2 scale
    let mu = (rating - 1500) / SCALE;
    let phi = rd / SCALE;

    const g = (phi_j) => 1 / Math.sqrt(1 + 3 * (phi_j ** 2) / PI2);
    const E = (mu, mu_j, phi_j) => 1 / (1 + Math.exp(-g(phi_j) * (mu - mu_j)));

    // If no match, increase RD (time decay)
    if (oppRating === null || oppRd === null || score === null) {
        const phiStar = Math.sqrt(phi ** 2 + sigma ** 2);
        return [rating, phiStar * SCALE, sigma];
    }

    // Step 2: Compute variance (v) and rating improvement estimate (delta)
    let mu_j = (oppRating - 1500) / SCALE;
    let phi_j = oppRd / SCALE;
    let E_val = E(mu, mu_j, phi_j);
    let g_phi = g(phi_j);

    let v = 1 / ((g_phi ** 2) * E_val * (1 - E_val));
    let delta = v * g_phi * (score - E_val);

    // Step 3: Update the volatility (sigma) using an iterative algorithm
    let a = Math.log(sigma ** 2);

    const f = (x) => {
        let expX = Math.exp(x);
        return (expX * (delta ** 2 - phi ** 2 - v - expX)) / 
               (2 * (phi ** 2 + v + expX) ** 2) - ((x - a) / (tau ** 2));
    };

    let A = a;
    let B = (delta ** 2 > phi ** 2 + v) ? Math.log(delta ** 2 - phi ** 2 - v) : a - tau;
    while (f(B) < 0) {
        B -= tau;
    }

    let fA = f(A);
    let fB = f(B);

    while (Math.abs(B - A) > epsilon) {
        let C = A + (A - B) * fA / (fB - fA);
        let fC = f(C);
        if (fC * fB < 0) {
            A = B;
            fA = fB;
        } else {
            fA /= 2;
        }
        B = C;
        fB = fC;
    }

    let sigmaPrime = Math.exp(A / 2);

    // Step 4: Update rating deviation (phi')
    let phiStar = Math.sqrt(phi ** 2 + sigmaPrime ** 2);
    let phiNew = 1 / Math.sqrt(1 / (phiStar ** 2) + 1 / v);

    // Step 5: Update rating
    let muNew = mu + (phiNew ** 2) * g_phi * (score - E_val);

    let newRating = 1500 + SCALE * muNew;
    let newRd = SCALE * phiNew;

    return {
      rating: newRating,
      rd: newRd,
      sigma: sigmaPrime
    };
}

