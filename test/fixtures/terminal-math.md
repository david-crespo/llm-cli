# Math in the terminal

## Inline math

Let \(x \in \mathbb{R}\), let \(\alpha,\beta > 0\), and define \(f(x)=\alpha x^2+\beta\).
Subscripts \(x_i\), superscripts \(e^{i\pi}\), and \(\mathcal{L}(\theta)\) sit alongside
prose. Equations can appear inside **bold: \(a^2+b^2=c^2\)** or _italics: \(e^{i\pi}+1=0\)_.

Both delimiter styles work: $\nu>0$ and \(\nu>0\). Punctuation stays outside the image:
\(x\), \(y\), and \(z\).

## Fractions, roots, and limits

The quadratic formula:

$$
x = \frac{-b \pm \sqrt{b^2-4ac}}{2a}
$$

An integral and an infinite series, using backslash display delimiters:

\[
\int_{-\infty}^{\infty} e^{-x^2}\,dx = \sqrt{\pi},
\qquad
\sum_{n=1}^{\infty}\frac{1}{n^2} = \frac{\pi^2}{6}
\]

A nested fraction needs more vertical room:

$$
f(x)=\frac{1}{1+\frac{x^2}{1+\frac{x^2}{3}}}
$$

## Matrices and cases

$$
\begin{bmatrix}
1 & 2 & 3 \\
0 & 1 & 4 \\
0 & 0 & 1
\end{bmatrix}
\begin{bmatrix}x\\y\\z\end{bmatrix}
=
\begin{bmatrix}x+2y+3z\\y+4z\\z\end{bmatrix}
$$

$$
|x| = \begin{cases}
-x & \text{if } x < 0,\\
x & \text{if } x \geq 0.
\end{cases}
$$

## Aligned derivation

$$
\begin{aligned}
(a+b)^2 &= (a+b)(a+b) \\
        &= a^2+ab+ba+b^2 \\
        &= a^2+2ab+b^2.
\end{aligned}
$$

## The original equation

The forcing term \(f\) is independent of whether viscosity \(\nu\) is zero:

$$
\partial_t u + (u\cdot\nabla)u = -\nabla p + \nu\Delta u + f,
\qquad \nabla\cdot u = 0
$$

## Lists, quotes, and tables

- With \(\nu>0\), this is Navier–Stokes.
- With \(\nu=0\), this is Euler.
- With \(f=0\), the equation is unforced.

> For a smooth unforced flow with suitable boundary conditions, viscosity dissipates energy:
>
> $$
> \frac{d}{dt}\frac{1}{2}\int |u|^2\,dx = -\nu\int |\nabla u|^2\,dx.
> $$

| Quantity      | Expression             |
| ------------- | ---------------------- |
| Norm          | \(\lVert x\rVert_2\)   |
| Inner product | \(\langle x,y\rangle\) |
| Gradient      | \(\nabla f\)           |

## Wide equations

Long display equations shrink to fit the available width:

$$
(a+b)^{12}=a^{12}+12a^{11}b+66a^{10}b^2+220a^9b^3+495a^8b^4+792a^7b^5+924a^6b^6+792a^5b^7+495a^4b^8+220a^3b^9+66a^2b^{10}+12ab^{11}+b^{12}
$$

## Currency and literal TeX

These are ordinary prices: $300, $300-$500, ~$300, and $30.7k versus $13.6k. A dollar sign
inside an actual equation works too: \(C(n)=\$5+\$0.02n\).

Code spans stay literal: `$x^2$`, `\(x^2\)`, and `\frac{a}{b}`. So do fenced code blocks:

```tex
$$
\frac{a}{b} + \sqrt{x}
$$
```

Invalid TeX falls back to its source: \(\notARealCommand{x}\).
